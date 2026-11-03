interface StatusProps {
  onRetry?: () => void;
}

/** Visible loading state for the quiz data fetch (F2). */
export function LoadingState() {
  return (
    <div className="status-panel" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>Loading trivia questions…</p>
    </div>
  );
}

/** Visible empty state when the API returns no usable questions (F2). */
export function EmptyState({ onRetry }: StatusProps) {
  return (
    <div className="status-panel" role="status">
      <p>No trivia questions are available right now.</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Visible error state for a failed remote call, with a retry action (F2). */
export function ErrorState({ message, onRetry }: StatusProps & { message: string }) {
  return (
    <div className="status-panel status-panel--error" role="alert">
      <p>Couldn't load trivia questions.</p>
      <p className="status-panel__detail">{message}</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
