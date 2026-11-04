// Page chrome for the public (no-login) pages.
export function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '20px 16px 48px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>{children}</div>
      <div className="muted small no-print" style={{ textAlign: 'center', marginTop: 24 }}>Secured link · OpenBooks</div>
    </div>
  );
}

export function Notice({ title, text, children }) {
  return (
    <Shell>
      <div className="empty" style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div className="empty-icon">🔒</div>
        <h3>{title}</h3>
        {text && <p className="muted">{text}</p>}
        {children}
      </div>
    </Shell>
  );
}

export function Loading() {
  return <Shell><div className="center pad"><span className="spin" /></div></Shell>;
}

/** Shown on every test-mode payment surface so nobody mistakes it for a live gateway. */
export function TestModeBanner() {
  return (
    <div className="callout warn" style={{ marginBottom: 14 }}>
      <span><b>TEST MODE</b> · No real money moves and no card details are collected.</span>
    </div>
  );
}
