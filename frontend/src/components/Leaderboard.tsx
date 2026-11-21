import { useLiveLeaderboard, type LiveStatus } from "../hooks/useLiveLeaderboard";

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

/**
 * Live leaderboard (F11). Players appear under synthetic nicknames only.
 * The status chip and the empty/loading/offline states cover F2 for this stream;
 * the event numbers in "Recent" make reconnect behaviour visible (no gaps, no repeats).
 */
export function Leaderboard() {
  const { leaderboard, activity, status, retry } = useLiveLeaderboard();

  return (
    <section className="leaderboard" aria-labelledby="leaderboard-title">
      <div className="leaderboard__header">
        <h2 id="leaderboard-title" className="leaderboard__title">
          Live leaderboard
        </h2>
        <span className={`live-status live-status--${status}`} role="status">
          <span className="live-status__dot" aria-hidden="true" />
          {STATUS_TEXT[status]}
        </span>
      </div>

      {status === "offline" && (
        <div className="leaderboard__offline" role="alert">
          <p>Live updates are unavailable. Still retrying in the background.</p>
          <button type="button" className="btn-secondary" onClick={retry}>
            Retry now
          </button>
        </div>
      )}

      {leaderboard === null ? (
        status !== "offline" && <p className="leaderboard__empty">Loading leaderboard…</p>
      ) : leaderboard.length === 0 ? (
        <p className="leaderboard__empty">No scores yet. Sign in and be the first!</p>
      ) : (
        <ol className="leaderboard__list">
          {leaderboard.map((entry) => (
            <li key={entry.player} className="leaderboard__row">
              <span className="leaderboard__rank">{entry.rank}</span>
              <span className="leaderboard__player">{entry.player}</span>
              <span className="leaderboard__points">{entry.points} pts</span>
            </li>
          ))}
        </ol>
      )}

      {activity.length > 0 && (
        <div className="leaderboard__activity">
          <h3 className="leaderboard__subtitle">Recent</h3>
          <ul>
            {activity.map((a) => (
              <li key={a.id}>
                <span className="leaderboard__event-id">#{a.id}</span> {a.player}{" "}
                {a.isCorrect ? "answered correctly" : "missed one"} ({a.sessionPoints} pts this game)
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
