/**
 * OpenTelemetry bootstrap (D10). Loaded BEFORE the application with
 *   node --import ./dist/telemetry.js dist/server.js      (npm start)
 * because instrumentation must hook module loading before express, pg and http
 * are imported.
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local development and tests
 * send nothing. On Render the standard OTEL_* variables are set in the dashboard
 * (the Grafana Cloud token lives there, never in the repo):
 *   OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf, OTEL_SERVICE_NAME,
 *   OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=staging|production
 *
 * What is exported:
 *   traces  — every request, with child spans for Postgres queries (pg) and outbound
 *             calls to The Simpsons API (http/undici): one trace spans the API, the
 *             database and the third-party service;
 *   metrics — http.server.request.duration (the SLI source), plus app counters
 *             (lib/metrics.ts);
 *   logs    — pino request/app logs, correlated with trace_id/span_id.
 */
import { register } from "node:module";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

type Shutdown = () => Promise<void>;
declare global {
  var __otelShutdown: Shutdown | undefined;
}

if (endpoint) {
  // ESM support: lets the instrumentations patch modules loaded via `import`.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [{ NodeSDK }, { getNodeAutoInstrumentations }, traceExp, metricExp, logExp, metrics, logs, res, semconv] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/exporter-logs-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  const sdk = new NodeSDK({
    // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES are merged in by the SDK.
    resource: res.resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "trivianerd-api",
      [semconv.ATTR_SERVICE_VERSION]: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "dev",
    }),
    traceExporter: new traceExp.OTLPTraceExporter(),
    metricReaders: [
      new metrics.PeriodicExportingMetricReader({
        exporter: new metricExp.OTLPMetricExporter(),
        exportIntervalMillis: 30_000,
      }),
    ],
    logRecordProcessors: [new logs.BatchLogRecordProcessor({ exporter: new logExp.OTLPLogExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // High-volume, low-value spans for this app.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });
  sdk.start();
  globalThis.__otelShutdown = () => sdk.shutdown();
  console.log(`OpenTelemetry enabled, exporting to ${new URL(endpoint).host}`);
}
