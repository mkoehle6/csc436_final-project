import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Question generation against a stubbed Simpsons API (F10). Reproduces the
 * production 502: page 60 holds only 2 characters, which is too thin for a
 * question (subject + 3 distinct wrong answers) on its own.
 * Expected values were predicted by hand before running.
 */

const realFetch = global.fetch;
let calls: number[] = [];

/** Characters with unique names/occupations per page, so pooled pages never collide. */
function page(pageNo: number, size: number) {
  return Array.from({ length: size }, (_, i) => ({
    id: pageNo * 100 + i,
    name: `Resident ${pageNo}-${i}`,
    occupation: `Job ${pageNo}-${i}`,
    portrait_path: "/x.webp",
    phrases: [],
  }));
}

function stub(handler: (pageNo: number, call: number) => { status: number; size?: number }) {
  calls = [];
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const pageNo = Number(url.searchParams.get("page"));
    calls.push(pageNo);
    const { status, size = 0 } = handler(pageNo, calls.length);
    if (status !== 200) return new Response(null, { status });
    const results = page(pageNo, size);
    return new Response(JSON.stringify({ count: results.length, next: null, prev: null, pages: 60, results }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function generator() {
  vi.resetModules(); // fresh Simpsons API cache per test
  return import("../src/lib/questionGenerator.js");
}

describe("generateCharacterQuestions", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("pools thin pages (2 characters each, like page 60) instead of failing", async () => {
    stub(() => ({ status: 200, size: 2 }));
    const { generateCharacterQuestions } = await generator();
    const qs = await generateCharacterQuestions(20);
    // Hand-predicted: 3 pages × 2 = 6 characters, 6 distinct jobs → each can be a subject → 6 questions.
    expect(qs).toHaveLength(6);
    expect(new Set(calls).size).toBe(3); // three distinct pages, the per-top-up cap
    for (const q of qs) expect(new Set(q.choices).size).toBe(4);
  });

  it("stops after one page when it already has enough characters", async () => {
    stub(() => ({ status: 200, size: 20 }));
    const { generateCharacterQuestions } = await generator();
    const qs = await generateCharacterQuestions(5);
    // Hand-predicted: 20 usable ≥ 5 + 3 → no second page; 5 questions.
    expect(qs).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it("skips a failing page and uses the others", async () => {
    let failingPage: number | undefined;
    stub((pageNo) => {
      failingPage ??= pageNo; // the first page requested is "down" (every retry fails too)
      return pageNo === failingPage ? { status: 503 } : { status: 200, size: 20 };
    });
    const { generateCharacterQuestions } = await generator();
    const qs = await generateCharacterQuestions(20);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.sourceEntityId !== undefined)).toBe(true);
  });

  it("reports the provider unavailable only when every page fails", async () => {
    stub(() => ({ status: 503 }));
    const { generateCharacterQuestions } = await generator();
    await expect(generateCharacterQuestions(20)).rejects.toMatchObject({ statusCode: 502, code: "UPSTREAM_UNAVAILABLE" });
    // Hand-predicted: 3 pages × (1 try + 2 retries) = 9 calls; bounded, not a retry storm.
    expect(calls).toHaveLength(9);
  });
});
