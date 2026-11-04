import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui.jsx';
import { CATEGORIES, REPORTS } from './registry.js';
import { Star } from 'lucide-react';
import './reports.css';

const FAV_KEY = 'ob_report_favorites';
function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]') || []; } catch { return []; }
}
function saveFavs(f) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch { /* storage unavailable */ }
}

export default function ReportsCenter() {
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState(loadFavs);
  const toggle = (key) => setFavs((f) => { const n = f.includes(key) ? f.filter((x) => x !== key) : [...f, key]; saveFavs(n); return n; });
  const match = useMemo(() => {
    const s = q.trim().toLowerCase();
    return REPORTS.filter((r) => !s || `${r.title} ${r.desc} ${r.cat}`.toLowerCase().includes(s));
  }, [q]);
  const groups = [['Favorites', match.filter((r) => favs.includes(r.key))], ...CATEGORIES.map((c) => [c, match.filter((r) => r.cat === c)])].filter(([, list]) => list.length);

  return (
    <div className="page">
      <PageHeader title="Reports Center" subtitle={`${REPORTS.length} reports`}>
        <input className="input search" placeholder="Search reports" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} autoFocus />
      </PageHeader>
      {!groups.length && <div className="empty"><h3>No reports match “{q}”</h3></div>}
      <div className="rc-grid">
        {groups.map(([cat, list]) => (
          <div key={cat} className="card rc-card">
            <div className="card-head"><h3>{cat === 'Favorites' ? <><Star size={16} strokeWidth={1.5} fill="currentColor" />Favorites</> : cat}</h3><span className="muted small">{list.length}</span></div>
            <div className="rc-list">
              {list.map((r) => (
                <div key={r.key} className="rc-item">
                  <Link to={`/reports/${r.key}`} title={r.desc}>{r.title}</Link>
                  <button type="button" className={`rc-star ${favs.includes(r.key) ? 'on' : ''}`} onClick={() => toggle(r.key)}
                    aria-label={favs.includes(r.key) ? `Remove ${r.title} from favorites` : `Add ${r.title} to favorites`}>{favs.includes(r.key) ? <Star size={18} strokeWidth={1.5} fill="currentColor" /> : <Star size={18} strokeWidth={1.5} />}</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
