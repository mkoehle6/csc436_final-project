import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stubbed third-party integration test (Q1 + F10): verifies timeout/retry handling
 * and graceful degradation when The Simpsons API is "down" or returns malformed data,
 * without making any real network call.
 */
describe("simpsonsApi (stubbed)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries on 500 and eventually succeeds", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount < 2) {
        return new Response(null, { status: 503 });
      }
      return new Response(
        JSON.stringify({
          count: 1,
          next: null,
          prev: null,
          pages: 1,
          results: [
            {
              id: 1,
              name: "Homer Simpson",
              age: 39,
              occupation: "Safety Inspector",
              gender: "Male",
              portrait_path: "/character/1.webp",
              phrases: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { simpsonsApi } = await import("../src/integrations/simpsonsApi.js");
    const page = await simpsonsApi.getCharactersPage(1);

    // Hand-predicted: first call fails (503), second call succeeds -> 2 total calls.
    expect(callCount).toBe(2);
    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.name).toBe("Homer Simpson");
  });

  it("throws a typed upstream error on repeated failure (graceful degradation)", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    const { simpsonsApi } = await import("../src/integrations/simpsonsApi.js");
    await expect(simpsonsApi.getCharactersPage(2)).rejects.toMatchObject({
      statusCode: 502,
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("rejects a response with an unexpected shape instead of trusting it", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { simpsonsApi } = await import("../src/integrations/simpsonsApi.js");
    await expect(simpsonsApi.getCharactersPage(3)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
