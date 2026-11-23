import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";

/**
 * F2: forced failures of the remote call that loads the quiz. The real app
 * (AuthProvider + App) is rendered; only the network is faked. Each test checks
 * what the player actually sees: loading, error with Retry, empty, and recovery.
 */

type Reply = () => Promise<Response>;

const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const networkDown: Reply = () => Promise.reject(new TypeError("Failed to fetch"));

const QUESTION = {
  id: 7,
  prompt: "Who is this character?",
  category: "character",
  choices: ["Homer Simpson", "Ned Flanders", "Moe Szyslak", "Barney Gumble"],
  imagePath: null,
};

let questionReplies: Reply[] = [];
let questionCalls = 0;

/** The leaderboard stream is not under test: a stand-in that never connects. */
class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  questionReplies = [];
  questionCalls = 0;
  vi.stubGlobal("EventSource", SilentEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/token")) return json(401, { error: { code: "UNAUTHENTICATED", message: "Not signed in" } })();
      if (url.includes("/api/questions?")) {
        questionCalls += 1;
        const reply = questionReplies.shift();
        if (!reply) throw new Error(`unexpected extra questions request #${questionCalls}`);
        return reply();
      }
      throw new Error(`unexpected request in test: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderApp = () =>
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );

describe("F2: quiz loading under forced failures", () => {
  it("shows a loading state while the questions request is in flight", async () => {
    let release: (r: Response) => void = () => {};
    questionReplies.push(() => new Promise<Response>((resolve) => (release = resolve)));

    renderApp();
    expect(screen.getAllByText("Loading trivia questions…")).toHaveLength(2); // sidebar + main panel

    await act(async () => release(await json(200, { questions: [QUESTION], degraded: false })()));
    expect(await screen.findByRole("heading", { name: QUESTION.prompt })).toBeTruthy();
    expect(screen.queryByText("Loading trivia questions…")).toBeNull();
  });

  it("network failure: shows the error with Retry, and Retry recovers", async () => {
    questionReplies.push(networkDown, json(200, { questions: [QUESTION], degraded: false }));

    renderApp();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.textContent).toContain("Couldn't load trivia questions.");
    expect(alerts[0]!.textContent).toContain("Could not reach the trivia server.");

    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);

    expect(await screen.findByRole("heading", { name: QUESTION.prompt })).toBeTruthy();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(questionCalls).toBe(2);
  });

  it("server error: shows the server's own message (not a crash or a blank page)", async () => {
    questionReplies.push(
      json(502, { error: { code: "UPSTREAM_UNAVAILABLE", message: "The Simpsons API is unavailable." } }),
    );

    renderApp();
    const [alert] = await screen.findAllByRole("alert");
    expect(alert!.textContent).toContain("The Simpsons API is unavailable.");
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
  });

  it("malformed response: rejected by validation and shown as an error", async () => {
    questionReplies.push(json(200, { questions: [{ id: "seven", prompt: 42 }] }));

    renderApp();
    const [alert] = await screen.findAllByRole("alert");
    expect(alert!.textContent).toContain("The trivia server returned an unexpected response.");
  });

  it("D9: the page has exactly one level-one heading, the app title", async () => {
    questionReplies.push(networkDown);

    renderApp();
    await screen.findAllByRole("alert");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("TriviaNerd");
  });

  it("no questions: shows the empty state with Try again", async () => {
    questionReplies.push(json(200, { questions: [], degraded: false }));

    renderApp();
    expect(await screen.findByText("No trivia questions are available right now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
