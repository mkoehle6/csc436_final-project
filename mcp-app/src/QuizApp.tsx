import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useState } from "react";

/**
 * TriviaNerd MCP App (F13). Rendered by the MCP host (e.g. Claude) in a
 * sandboxed iframe after the model calls `play_trivia`.
 *
 * The app has no network access of its own: it receives the game through the
 * host (ontoolresult) and scores answers by asking the host to call
 * `submit_answer` on the TriviaNerd MCP server over the user's authenticated
 * connection. The server checks the token's scope on every call, so the app
 * can never do more than the user's connection allows.
 */

interface Question {
  id: number;
  prompt: string;
  choices: string[];
  imagePath: string | null;
}

interface Game {
  sessionId: number;
  player: string;
  questions: Question[];
}

interface Score {
  correctCount: number;
  totalCount: number;
  points: number;
}

type AnswerState =
  | { status: "pending"; selected: string }
  | { status: "done"; selected: string; isCorrect: boolean; correctAnswer: string }
  | { status: "error"; selected: string; message: string };

interface LeaderboardEntry {
  rank: number;
  player: string;
  points: number;
}

interface ToolResultLike {
  structuredContent?: unknown;
  content?: unknown;
  isError?: boolean;
}

// ── Runtime validation: results come from outside the app.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseGame(v: unknown): Game | null {
  if (!isRecord(v) || typeof v.sessionId !== "number" || typeof v.player !== "string" || !Array.isArray(v.questions)) return null;
  const questions = v.questions.filter(
    (q): q is Question =>
      isRecord(q) &&
      typeof q.id === "number" &&
      typeof q.prompt === "string" &&
      Array.isArray(q.choices) &&
      q.choices.every((c) => typeof c === "string") &&
      (q.imagePath === null || typeof q.imagePath === "string"),
  );
  return questions.length > 0 ? { sessionId: v.sessionId, player: v.player, questions } : null;
}

function textOf(result: ToolResultLike): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join(" ")
    .trim();
}

function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Refused by the server's scope check (HTTP 403 insufficient_scope).
  if (/403|insufficient_scope|forbidden/i.test(message)) {
    return "Your TriviaNerd connection isn't allowed to play. Reconnect TriviaNerd and allow \"Play trivia games\".";
  }
  return "Couldn't reach TriviaNerd. Check your connection and try again.";
}

export function QuizApp() {
  const [game, setGame] = useState<Game | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<number, AnswerState>>(new Map());
  const [score, setScore] = useState<Score | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[] | "loading" | "error" | null>(null);

  const onAppCreated = useCallback((app: App) => {
    // Set before connect, so the initial tool result is not missed.
    app.ontoolresult = (result: ToolResultLike) => {
      if (result.isError) {
        setStartError(textOf(result) || "TriviaNerd could not start a game.");
        return;
      }
      const parsed = parseGame(result.structuredContent);
      if (parsed) {
        setGame(parsed);
        setIndex(0);
        setAnswers(new Map());
        setScore(null);
        setBoard(null);
      } else {
        setStartError("TriviaNerd sent a game this app could not read.");
      }
    };
  }, []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "TriviaNerd Quiz", version: "1.0.0" },
    capabilities: {},
    onAppCreated,
  });

  const setAnswer = (questionId: number, state: AnswerState) =>
    setAnswers((prev) => new Map(prev).set(questionId, state));

  const answer = async (question: Question, selected: string) => {
    if (!app || !game) return;
    setAnswer(question.id, { status: "pending", selected });
    try {
      const result: ToolResultLike = await app.callServerTool({
        name: "submit_answer",
        arguments: { sessionId: game.sessionId, questionId: question.id, selectedAnswer: selected },
      });
      const data = result.structuredContent;
      if (result.isError || !isRecord(data) || typeof data.isCorrect !== "boolean" || typeof data.correctAnswer !== "string") {
        setAnswer(question.id, { status: "error", selected, message: textOf(result) || "TriviaNerd could not score that answer." });
        return;
      }
      setAnswer(question.id, { status: "done", selected, isCorrect: data.isCorrect, correctAnswer: data.correctAnswer });
      if (isRecord(data.score) && typeof data.score.points === "number") setScore(data.score as unknown as Score);
    } catch (err) {
      setAnswer(question.id, { status: "error", selected, message: describeFailure(err) });
    }
  };

  const showLeaderboard = async () => {
    if (!app) return;
    setBoard("loading");
    try {
      const result: ToolResultLike = await app.callServerTool({ name: "get_leaderboard", arguments: {} });
      const data = result.structuredContent;
      setBoard(isRecord(data) && Array.isArray(data.leaderboard) ? (data.leaderboard as LeaderboardEntry[]) : "error");
    } catch {
      setBoard("error");
    }
  };

  // ── Connection and start states (F2: every remote step is visible).
  if (error) return <Status kind="error" text={`Couldn't connect to the host: ${error.message}`} />;
  if (!isConnected) return <Status kind="loading" text="Connecting to TriviaNerd…" />;
  if (startError) return <Status kind="error" text={startError} />;
  if (!game) return <Status kind="loading" text="Waiting for your game to start…" />;

  const finished = index >= game.questions.length;
  const question = game.questions[index];
  const state = question ? answers.get(question.id) : undefined;
  const locked = state?.status === "pending" || state?.status === "done";

  return (
    <main className="quiz">
      <header className="quiz__header">
        <span className="quiz__brand">
          Trivia<span>Nerd</span>
        </span>
        <span className="quiz__player">{game.player}</span>
        <span className="quiz__score" aria-live="polite">
          {score ? `${score.points} pts · ${score.correctCount}/${score.totalCount}` : "0 pts"}
        </span>
      </header>

      {!finished && question && (
        <section className="card" aria-labelledby="prompt">
          <p className="card__progress">
            Question {index + 1} of {game.questions.length}
          </p>
          <h1 id="prompt" className="card__prompt">
            {question.prompt}
          </h1>
          {question.imagePath && <img className="card__image" src={question.imagePath} alt="" />}

          <div className="choices">
            {question.choices.map((choice) => {
              const selected = state?.selected === choice;
              const correct = state?.status === "done" && state.correctAnswer === choice;
              const wrong = state?.status === "done" && selected && !correct;
              return (
                <button
                  key={choice}
                  type="button"
                  className={["choice", correct ? "choice--correct" : "", wrong ? "choice--wrong" : "", selected && state?.status === "pending" ? "choice--pending" : ""].join(" ")}
                  onClick={() => void answer(question, choice)}
                  disabled={locked}
                  aria-pressed={selected}
                >
                  {choice}
                  {correct && <span aria-label="Correct answer"> ✓</span>}
                </button>
              );
            })}
          </div>

          <div aria-live="polite">
            {state?.status === "pending" && <p className="feedback">Checking your answer…</p>}
            {state?.status === "done" && (
              <p className={`feedback ${state.isCorrect ? "feedback--right" : "feedback--wrong"}`}>
                {state.isCorrect ? "Correct!" : `Not quite. The answer is ${state.correctAnswer}.`}
              </p>
            )}
            {state?.status === "error" && (
              <div className="feedback feedback--error" role="alert">
                <p>{state.message}</p>
                <button type="button" className="action" onClick={() => void answer(question, state.selected)}>
                  Retry
                </button>
              </div>
            )}
          </div>

          {state?.status === "done" && (
            <button type="button" className="action" onClick={() => setIndex((i) => i + 1)}>
              {index + 1 < game.questions.length ? "Next question" : "See results"}
            </button>
          )}
        </section>
      )}

      {finished && (
        <section className="card" aria-labelledby="results">
          <h1 id="results" className="card__prompt">
            Game over: {score ? `${score.points} points (${score.correctCount}/${score.totalCount} correct)` : "no answers recorded"}
          </h1>
          <p className="card__progress">Your score is saved and shows on the TriviaNerd live leaderboard.</p>
          <button type="button" className="action" onClick={() => void showLeaderboard()}>
            Show leaderboard
          </button>
          {board === "loading" && <p className="feedback">Loading leaderboard…</p>}
          {board === "error" && <p className="feedback feedback--error">Couldn't load the leaderboard.</p>}
          {Array.isArray(board) &&
            (board.length === 0 ? (
              <p className="feedback">No scores yet.</p>
            ) : (
              <ol className="board">
                {board.map((e) => (
                  <li key={e.player}>
                    <span>{e.rank}.</span> {e.player} <strong>{e.points} pts</strong>
                  </li>
                ))}
              </ol>
            ))}
        </section>
      )}
    </main>
  );
}

function Status({ kind, text }: { kind: "loading" | "error"; text: string }) {
  return (
    <main className="quiz">
      <p className={`status status--${kind}`} role={kind === "error" ? "alert" : "status"}>
        {text}
      </p>
    </main>
  );
}
