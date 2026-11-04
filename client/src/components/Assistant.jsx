// Floating "Ask" assistant panel.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Button } from './ui.jsx';

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState([]);
  const nav = useNavigate();
  const end = useRef();
  useEffect(() => { if (open && !sugg.length) api.get('/assistant/suggestions').then(setSugg).catch(() => {}); }, [open]); // eslint-disable-line
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
  const ask = async (text) => {
    const t = (text ?? q).trim();
    if (!t) return;
    setQ('');
    setMsgs((m) => [...m, { me: true, text: t }]);
    setBusy(true);
    try { const r = await api.post('/assistant', { q: t }); setMsgs((m) => [...m, r]); } catch (e) { setMsgs((m) => [...m, { text: e.message }]); }
    setBusy(false);
  };
  if (!open) return <button className="ask-fab" onClick={() => setOpen(true)} title="Ask OpenBooks">✨ Ask</button>;
  return (
    <div className="ask-panel">
      <div className="ask-head"><b>✨ Ask OpenBooks</b><button className="icon-btn" onClick={() => setOpen(false)}>×</button></div>
      <div className="ask-body">
        {!msgs.length && <div className="muted small">Ask about your books in plain English.</div>}
        {!msgs.length && <div className="ask-sugg">{sugg.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`ask-msg ${m.me ? 'me' : ''}`}>
            <div>{m.text}</div>
            {m.table?.length > 0 && <table className="ask-table"><tbody>{m.table.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>}
            {m.link && <Button size="sm" variant="link" onClick={() => nav(m.link.url)}>{m.link.label} →</Button>}
            {m.suggestions && <div className="ask-sugg">{m.suggestions.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>}
          </div>
        ))}
        {busy && <div className="ask-msg"><span className="spin" /></div>}
        <div ref={end} />
      </div>
      <form className="ask-input" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How many invoices are overdue?" />
        <Button type="submit" variant="primary">Ask</Button>
      </form>
    </div>
  );
}
