import { metrics } from "@opentelemetry/api";

/**
 * Application metrics (D10). Recorded through the OpenTelemetry API, which is a
 * no-op until src/telemetry.ts starts the SDK, so tests and local runs are unaffected.
 */
const meter = metrics.getMeter("trivianerd");

/** Answers scored, by channel (web | mcp) and correctness. */
export const answersCounter = meter.createCounter("trivianerd.answers", {
  description: "Answers recorded in game sessions",
});

/** Calls to The Simpsons API, by outcome (ok | error), for the third-party dependency's health. */
export const simpsonsApiCalls = meter.createCounter("trivianerd.simpsons_api.calls", {
  description: "Requests made to The Simpsons API",
});

/** Question-bank top-ups, by outcome (done | skipped | failed). */
export const bankTopUps = meter.createCounter("trivianerd.question_bank.top_ups", {
  description: "Question bank top-up attempts",
});
