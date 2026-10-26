export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  );
}

export function ReadOnlyNote({ who }: { who: string }) {
  return (
    <div className="note ro">
      <LockIcon /> Только просмотр. Изменять это может {who}.
    </div>
  );
}
