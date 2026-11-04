// Comments + history (audit trail) for any record.
import { useState } from 'react';
import { api } from '../api.js';
import { useApp, useFetch } from '../store.jsx';
import { Button, Textarea } from './ui.jsx';
import { MessageSquare } from 'lucide-react';

export default function ActivityPanel({ entityType, entityId, refreshKey }) {
  const { toast } = useApp();
  const comments = useFetch('/comments', { entity_type: entityType, entity_id: entityId }, [refreshKey]);
  const history = useFetch('/activity', { entity_type: entityType, entity_id: entityId }, [refreshKey]);
  const [text, setText] = useState('');
  const add = async () => {
    try { await api.post('/comments', { entity_type: entityType, entity_id: entityId, text }); setText(''); comments.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const items = [
    ...(comments.data || []).map((c) => ({ id: `c${c.id}`, at: c.created_at, who: c.author || 'User', text: c.text, comment: true })),
    ...(history.data || []).map((a) => ({ id: `a${a.id}`, at: a.created_at, who: a.user_name || 'System', text: `${a.action}${a.detail ? ` – ${a.detail}` : ''}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Textarea className="grow" rows={2} placeholder="Add a comment (internal)" value={text} onChange={(e) => setText(e.target.value)} />
        <Button disabled={!text.trim()} onClick={add}>Add Comment</Button>
      </div>
      <div className="timeline">
        {items.map((i) => (
          <div key={i.id} className={`tl-item ${i.comment ? 'tl-comment' : ''}`}>
            <div className="tl-dot" />
            <div>
              <div className="small muted">{new Date(`${i.at.replace(' ', 'T')}Z`).toLocaleString()} · {i.who}</div>
              <div>{i.comment ? <><MessageSquare size={16} strokeWidth={1.5} /> </> : null}{i.text}</div>
            </div>
          </div>
        ))}
        {!items.length && <div className="muted">No activity yet.</div>}
      </div>
    </div>
  );
}
