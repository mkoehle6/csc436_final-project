import { describe, expect, it, vi } from "vitest";

/**
 * D10 regression: telemetry configuration must never crash the app. A staging
 * deploy once failed because OTEL_EXPORTER_OTLP_ENDPOINT lacked "https://" and the
 * bootstrap threw; the health check kept the old version up. Importing the module
 * with no endpoint set starts nothing.
 */
describe("otlpEndpoint", () => {
  it.each([
    ["https://otlp-gateway-prod-us-east-6.grafana.net/otlp", "otlp-gateway-prod-us-east-6.grafana.net"],
    ["http://127.0.0.1:4318", "127.0.0.1:4318"],
  ])("accepts %s", async (raw, host) => {
    const { otlpEndpoint } = await import("../src/telemetry.js");
    expect(otlpEndpoint(raw)?.host).toBe(host);
  });

  it.each([
    "otlp-gateway-prod-us-east-6.grafana.net/otlp", // the exact value that crashed staging
    "ftp://example.com/otlp",
    "not a url",
  ])("disables telemetry (null + warning, no throw) for %j", async (raw) => {
    const { otlpEndpoint } = await import("../src/telemetry.js");
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(otlpEndpoint(raw)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OpenTelemetry DISABLED"));
    warn.mockRestore();
  });

  it("is off, silently, when no endpoint is configured", async () => {
    const { otlpEndpoint } = await import("../src/telemetry.js");
    expect(otlpEndpoint("")).toBeNull();
    expect(otlpEndpoint(undefined)).toBeNull();
  });
});
