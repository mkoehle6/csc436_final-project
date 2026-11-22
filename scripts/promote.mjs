// Promote staging → production, enforcing D3 ("changes reach production through staging").
//
// For each service (backend first, then frontend), production is moved to exactly
// the commit STAGING is running, and only if:
//   1. staging reports a commit (backend: /healthz `commit`; frontend: <meta name="app-commit">)
//      and the staging backend is healthy (HTTP 200, status "ok");
//   2. the CI workflow succeeded for that commit (GitHub API);
//   3. production is not already on it.
// Then it calls the service's Render deploy hook with ?ref=<commit> and waits until
// production reports that commit, failing if it does not within the timeout.
//
// Env:
//   STAGING_API, STAGING_WEB, PROD_API, PROD_WEB   base URLs
//   RENDER_DEPLOY_HOOK_API_PROD, RENDER_DEPLOY_HOOK_WEB_PROD   secrets (never printed)
//   GITHUB_TOKEN, GITHUB_REPOSITORY                for the CI-status check
//   DRY_RUN=true                                   check and report, deploy nothing
//   PROMOTE_TIMEOUT_MINUTES (default 15), GITHUB_STEP_SUMMARY (optional)
import fs from "node:fs";

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
};

const DRY_RUN = process.env.DRY_RUN === "true";
const TIMEOUT_MS = Number(process.env.PROMOTE_TIMEOUT_MINUTES ?? 15) * 60_000;
const POLL_MS = 15_000;
const SHA_RE = /^[0-9a-f]{40}$/;

const summary = [];
const log = (line) => {
  console.log(line);
  summary.push(line);
};
const short = (sha) => (sha ? sha.slice(0, 7) : "none");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, init = {}, ms = 30_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Backend commit from /healthz; `healthy` only when HTTP 200 and status "ok". */
async function backendState(base) {
  try {
    const res = await fetchWithTimeout(`${base}/healthz`, { headers: { "Cache-Control": "no-cache" } }, 70_000);
    const body = await res.json().catch(() => ({}));
    return { commit: typeof body.commit === "string" ? body.commit : null, healthy: res.ok && body.status === "ok" };
  } catch {
    return { commit: null, healthy: false };
  }
}

/** Frontend commit from <meta name="app-commit">; a cache-busting query avoids stale HTML. */
async function frontendState(base) {
  try {
    const res = await fetchWithTimeout(`${base}/?promote=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
    const html = await res.text();
    const m = html.match(/<meta\s+name="app-commit"\s+content="([^"]*)"/);
    return { commit: m ? m[1] : null, healthy: res.ok };
  } catch {
    return { commit: null, healthy: false };
  }
}

async function ciPassed(sha) {
  const token = env("GITHUB_TOKEN");
  const repo = env("GITHUB_REPOSITORY");
  const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} while checking CI for ${short(sha)}`);
  const { workflow_runs: runs = [] } = await res.json();
  return runs.some((r) => r.name === "CI" && r.conclusion === "success");
}

async function triggerDeploy(hookUrl, sha) {
  const url = new URL(hookUrl);
  url.searchParams.set("ref", sha); // deploy exactly this commit, not "latest"
  const res = await fetchWithTimeout(url, { method: "POST" });
  if (!res.ok) throw new Error(`Render deploy hook returned HTTP ${res.status}`); // URL deliberately not printed
}

async function waitForCommit(read, sha, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() < deadline) {
    const state = await read();
    if (state.commit === sha && state.healthy) return Math.round((Date.now() - started) / 1000);
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not report ${short(sha)} within ${TIMEOUT_MS / 60_000} minutes`);
}

/** Paths whose changes trigger each service's build: same as buildFilter in render.yaml. */
const SHARED_PATHS = ["package.json", "package-lock.json", "render.yaml"];

const services = [
  {
    name: "backend",
    staging: () => backendState(env("STAGING_API")),
    prod: () => backendState(env("PROD_API")),
    hook: () => env("RENDER_DEPLOY_HOOK_API_PROD"),
    buildsOn: (file) => file.startsWith("backend/") || SHARED_PATHS.includes(file),
  },
  {
    name: "frontend",
    staging: () => frontendState(env("STAGING_WEB")),
    prod: () => frontendState(env("PROD_WEB")),
    hook: () => env("RENDER_DEPLOY_HOOK_WEB_PROD"),
    buildsOn: (file) => file.startsWith("frontend/") || SHARED_PATHS.includes(file),
  },
];

async function github(path) {
  const res = await fetchWithTimeout(`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}${path}`, {
    headers: { Authorization: `Bearer ${env("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${path}`);
  return res.json();
}

/** Status of the CI workflow for a commit, e.g. "in progress", "failure", "not started". */
async function ciStatus(sha) {
  const { workflow_runs: runs = [] } = await github(`/actions/runs?head_sha=${sha}&per_page=50`);
  const run = runs.find((r) => r.name === "CI");
  if (!run) return "not started";
  return run.status === "completed" ? run.conclusion : run.status.replace("_", " ");
}

/**
 * Warns when main has commits that change a service's files but have not reached
 * staging yet (CI still running, deploy still in progress, or CI failed). Without
 * this, a Promote started too early "succeeds" by promoting nothing. Commits that
 * do not touch the service (docs, the other service) never reach staging by design
 * (render.yaml buildFilter), so they are ignored rather than reported.
 */
async function behindMainWarning(svc, stagingSha) {
  const head = process.env.GITHUB_SHA;
  if (!head || !SHA_RE.test(head) || head === stagingSha) return null;
  const compare = await github(`/compare/${stagingSha}...${head}`);
  if (compare.status === "behind" || compare.status === "identical") return null;
  const relevant = (compare.files ?? []).map((f) => f.filename).filter(svc.buildsOn);
  if (relevant.length === 0) return null;
  return (
    `⚠️ ${svc.name}: \`main\` is at \`${short(head)}\` (CI: ${await ciStatus(head)}), which changes ` +
    `${relevant.length} ${svc.name} file(s) that staging (\`${short(stagingSha)}\`) does not have yet. ` +
    `Wait until staging runs \`${short(head)}\`, then run Promote again.`
  );
}

const warnings = [];

let failed = false;
log(`## Promote staging → production${DRY_RUN ? " (dry run)" : ""}`);
log("");
log("| Service | Staging | Production before | Result |");
log("| --- | --- | --- | --- |");

for (const svc of services) {
  const [stg, prd] = await Promise.all([svc.staging(), svc.prod()]);
  const row = (result) => log(`| ${svc.name} | \`${short(stg.commit)}\` | \`${short(prd.commit)}\` | ${result} |`);

  if (!stg.commit || !SHA_RE.test(stg.commit)) {
    row("❌ staging does not report a commit");
    failed = true;
    continue;
  }
  if (!stg.healthy) {
    row("❌ staging is not healthy");
    failed = true;
    continue;
  }
  if (!(await ciPassed(stg.commit))) {
    row(`❌ CI has not passed for \`${short(stg.commit)}\``);
    failed = true;
    continue;
  }
  try {
    const warning = await behindMainWarning(svc, stg.commit);
    if (warning) warnings.push(warning);
  } catch (err) {
    warnings.push(`⚠️ ${svc.name}: could not compare staging with main (${err.message})`);
  }
  if (prd.commit === stg.commit) {
    row("✅ already up to date");
    continue;
  }
  // Promotion only moves production forward. If staging runs an older commit than
  // production (e.g. staging was rolled back), promoting would silently roll
  // production back too; that must be a deliberate rollback, not a side effect.
  if (prd.commit && SHA_RE.test(prd.commit)) {
    try {
      const { status } = await github(`/compare/${prd.commit}...${stg.commit}`);
      if (status !== "ahead") {
        row(`❌ staging is ${status === "behind" ? "older than" : "not ahead of"} production; refusing to move production backwards`);
        failed = true;
        continue;
      }
    } catch (err) {
      row(`❌ could not confirm staging is newer than production (${err.message})`);
      failed = true;
      continue;
    }
  }
  if (DRY_RUN) {
    row(`would deploy \`${short(stg.commit)}\``);
    continue;
  }
  try {
    await triggerDeploy(svc.hook(), stg.commit);
    const seconds = await waitForCommit(svc.prod, stg.commit, `production ${svc.name}`);
    row(`✅ promoted to \`${short(stg.commit)}\` (live after ${seconds} s)`);
  } catch (err) {
    row(`❌ ${err.message}`);
    failed = true;
    break; // never deploy the frontend if the backend promotion failed
  }
}

if (warnings.length > 0) {
  log("");
  for (const w of warnings) log(w);
}

if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
process.exit(failed ? 1 : 0);
