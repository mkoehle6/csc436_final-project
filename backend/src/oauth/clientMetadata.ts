import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";

/**
 * Client ID Metadata Documents (CIMD), the client-registration mechanism the MCP
 * authorization spec (2026-07-28) recommends: an MCP client's `client_id` is an
 * HTTPS URL, and the document served there describes the client (name,
 * redirect URIs). No registration endpoint or stored client secrets.
 *
 * Fetching a URL chosen by the caller is an SSRF risk, so the fetch is locked down:
 *   - https only, a real path, no credentials or fragment in the URL;
 *   - every address the host resolves to must be public (no loopback, private,
 *     link-local, CGNAT, multicast or reserved ranges);
 *   - no redirects, 5 s timeout, 64 KB size cap, JSON only;
 *   - the document's `client_id` must equal the URL exactly.
 * Residual risk, accepted and documented: DNS could change between our lookup and
 * the fetch's own lookup (rebinding); the limits above bound what that could reach.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const MIN_CACHE_MS = 60 * 1000;
const MAX_CACHE_MS = 24 * 60 * 60 * 1000;

export class ClientMetadataError extends Error {}

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  clientUri?: string | undefined;
}

/** Redirect URIs must be https, or http on a loopback host (native/desktop clients). */
function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const documentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string()).min(1).max(20),
  client_uri: z.string().url().optional(),
  // We only support public clients (PKCE, no client secret or key).
  token_endpoint_auth_method: z.literal("none").optional(),
});

/** Validates the shape of a URL-formatted client_id (spec: https scheme with a path). */
export function parseClientIdUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientMetadataError("client_id must be an HTTPS URL");
  }
  if (url.protocol !== "https:") throw new ClientMetadataError("client_id must use https");
  if (url.pathname === "/" || url.pathname === "") throw new ClientMetadataError("client_id URL must contain a path");
  if (url.hash || url.username || url.password) throw new ClientMetadataError("client_id URL must not contain credentials or a fragment");
  if (url.href !== raw) throw new ClientMetadataError("client_id must be a normalised URL");
  return url;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for any address an outbound fetch must not reach. */
export function isNonPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isNonPublicAddress(mapped[1]!);
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // fc00::/7 unique local
      /^fe[89ab]/.test(lower) || // fe80::/10 link-local
      /^ff/.test(lower) || // multicast
      lower.startsWith("2001:db8") // documentation
    );
  }
  return true; // not an IP at all: refuse
}

/** Only for automated tests, which serve documents from hosts that do not resolve publicly. */
const allowNonPublicHosts = () => process.env.NODE_ENV === "test" && process.env.CIMD_ALLOW_NON_PUBLIC_HOSTS === "true";

async function assertPublicHost(hostname: string): Promise<void> {
  if (allowNonPublicHosts()) return;
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new ClientMetadataError("client_id host does not resolve");
  if (addresses.some((a) => isNonPublicAddress(a.address))) {
    throw new ClientMetadataError("client_id host resolves to a non-public address");
  }
}

async function readLimited(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new ClientMetadataError("client metadata document is too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new ClientMetadataError("client metadata document is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cacheLifetimeMs(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_CACHE_MS;
  if (/no-store|no-cache/i.test(cacheControl)) return 0;
  const maxAge = /max-age=(\d+)/i.exec(cacheControl);
  if (!maxAge) return DEFAULT_CACHE_MS;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, Number(maxAge[1]) * 1000));
}

const cache = new Map<string, { value: ClientMetadata; expiresAt: number }>();

/** Fetches, validates and caches the metadata document for a URL-formatted client_id. */
export async function getClientMetadata(clientId: string): Promise<ClientMetadata> {
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = parseClientIdUrl(clientId);
  await assertPublicHost(url.hostname);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ClientMetadataError("client metadata document could not be fetched");
  }
  if (!res.ok) throw new ClientMetadataError(`client metadata document returned HTTP ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new ClientMetadataError("client metadata document is not JSON");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readLimited(res));
  } catch (err) {
    if (err instanceof ClientMetadataError) throw err;
    throw new ClientMetadataError("client metadata document is not valid JSON");
  }
  const doc = documentSchema.safeParse(parsedJson);
  if (!doc.success) throw new ClientMetadataError("client metadata document is missing required fields or uses unsupported settings");
  if (doc.data.client_id !== clientId) throw new ClientMetadataError("client metadata document's client_id does not match its URL");
  if (!doc.data.redirect_uris.every(isAcceptableRedirect)) {
    throw new ClientMetadataError("client metadata document lists a redirect URI that is neither https nor loopback");
  }

  const value: ClientMetadata = {
    clientId,
    clientName: doc.data.client_name,
    redirectUris: doc.data.redirect_uris,
    clientUri: doc.data.client_uri,
  };
  const ttl = cacheLifetimeMs(res.headers.get("cache-control"));
  if (ttl > 0) cache.set(clientId, { value, expiresAt: Date.now() + ttl });
  return value;
}
