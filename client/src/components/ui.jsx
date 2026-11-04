// Shared UI kit. Every page should build from these so the app looks consistent.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useApp } from '../store.jsx';
import { statusLabel } from '../lib/format.js';
import { ACCOUNT_TYPE_LABELS } from '@shared/calc.js';

export function Button({ variant = 'secondary', size, className = '', loading, children, ...p }) {
  return (
    <button type="button" className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`} disabled={loading || p.disabled} {...p}>
      {loading ? <span className="spin" /> : null}{children}
    </button>
  );
}

export function Field({ label, required, hint, error, children, className = '', inline }) {
  return (
    <label className={`field ${inline ? 'field-inline' : ''} ${className}`}>
      {label && <span className={`field-label ${required ? 'req' : ''}`}>{label}</span>}
      <span className="field-control">
        {children}
        {hint && <small className="hint">{hint}</small>}
        {error && <small className="field-error">{error}</small>}
      </span>
    </label>
  );
}

export const Input = ({ className = '', ...p }) => <input className={`input ${className}`} {...p} value={p.value ?? ''} />;
export const Textarea = ({ className = '', ...p }) => <textarea className={`input ${className}`} rows={3} {...p} value={p.value ?? ''} />;
export const NumberInput = ({ className = '', onChange, ...p }) => (
  <input type="number" step="any" className={`input num ${className}`} {...p} value={p.value ?? ''} onChange={(e) => onChange?.(e.target.value === '' ? '' : e.target.value, e)} />
);

export function Select({ options = [], placeholder, className = '', ...p }) {
  return (
    <select className={`input ${className}`} {...p} value={p.value ?? ''}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (Array.isArray(o)
        ? <option key={o[0]} value={o[0]}>{o[1]}</option>
        : o.group ? <optgroup key={o.group} label={o.group}>{o.options.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</optgroup>
          : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, ...p }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} {...p} />
      <span>{label}</span>
    </label>
  );
}

export function Modal({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>, document.body);
}

const STATUS_COLORS = {
  draft: 'gray', pending_approval: 'orange', open: 'blue', sent: 'blue', paid: 'green', partially_paid: 'orange', overdue: 'red', void: 'gray',
  closed: 'green', accepted: 'green', declined: 'red', invoiced: 'green', expired: 'red', billed: 'green', cancelled: 'gray', delivered: 'green',
  returned: 'orange', active: 'green', paused: 'orange', stopped: 'gray', unbilled: 'orange', 'non-billable': 'gray', invoiced_: 'green',
  uncategorized: 'orange', categorized: 'green', matched: 'green', excluded: 'gray', reconciled: 'green', approved: 'green', rejected: 'red',
  submitted: 'orange', inactive: 'gray', in_progress: 'blue', completed: 'green', expired_: 'red', queued: 'gray', logged: 'blue', failed: 'red',
};
export function Badge({ status, children, color }) {
  return <span className={`badge badge-${color || STATUS_COLORS[status] || 'gray'}`}>{children || statusLabel(status)}</span>;
}

export function PageHeader({ title, subtitle, actions, children, back }) {
  return (
    <div className="page-head">
      <div className="page-head-row">
        <div className="page-title">
          {back}
          <div><h1>{title}</h1>{subtitle && <div className="muted small">{subtitle}</div>}</div>
        </div>
        <div className="page-actions">{actions}</div>
      </div>
      {children && <div className="page-filters">{children}</div>}
    </div>
  );
}

export function Table({ columns, rows, onRowClick, empty = 'No records found.', loading, footer, rowKey = 'id', selectable, selected, onSelect, rowClass }) {
  const allSel = selectable && rows?.length && rows.every((r) => selected?.includes(r[rowKey]));
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th style={{ width: 32 }}><input type="checkbox" checked={!!allSel} onChange={(e) => onSelect(e.target.checked ? rows.map((r) => r[rowKey]) : [])} /></th>}
            {columns.map((c) => <th key={c.key || c.label} className={c.align === 'right' ? 'r' : ''} style={{ width: c.width }}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={columns.length + (selectable ? 1 : 0)} className="center muted pad"><span className="spin" /> Loading…</td></tr>}
          {!loading && !rows?.length && <tr><td colSpan={columns.length + (selectable ? 1 : 0)} className="center muted pad">{empty}</td></tr>}
          {!loading && rows?.map((r, i) => (
            <tr key={r[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={`${onRowClick ? 'clickable' : ''} ${rowClass ? rowClass(r) : ''}`}>
              {selectable && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected?.includes(r[rowKey])} onChange={(e) => onSelect(e.target.checked ? [...selected, r[rowKey]] : selected.filter((x) => x !== r[rowKey]))} /></td>}
              {columns.map((c) => <td key={c.key || c.label} className={c.align === 'right' ? 'r' : ''}>{c.render ? c.render(r, i) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => <button key={t.key} type="button" className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>{t.label}{t.count != null && <span className="tab-count">{t.count}</span>}</button>)}
    </div>
  );
}

export function Card({ title, actions, children, className = '', pad = true }) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && <div className="card-head"><h3>{title}</h3><div>{actions}</div></div>}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </div>
  );
}

export function Empty({ title, text, action, icon: Icon = FileText }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon size={32} strokeWidth={1.25} /></div>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export const Spinner = () => <div className="center pad"><span className="spin" /></div>;

export function Money({ value, currency, className = '' }) {
  const { money } = useApp();
  return <span className={`money ${Number(value) < 0 ? 'neg' : ''} ${className}`}>{money(value, currency)}</span>;
}

/** Dropdown menu: <Menu label="More" items={[{label, onClick, danger, hidden}]} /> */
export function Menu({ label = '⋯', items, variant = 'secondary', align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const visible = items.filter((i) => i && !i.hidden);
  if (!visible.length) return null;
  return (
    <div className="menu" ref={ref}>
      <Button variant={variant} onClick={() => setOpen((o) => !o)}>{label}<ChevronDown size={14} strokeWidth={1.75} className="ic-caret" /></Button>
      {open && (
        <div className={`menu-list menu-${align}`}>
          {visible.map((i, k) => (i.divider ? <div key={k} className="menu-div" /> : (
            <button key={k} type="button" className={`menu-item ${i.danger ? 'danger' : ''}`} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>
          )))}
        </div>
      )}
    </div>
  );
}

/**
 * Searchable combobox.
 * options: [{value, label, sub?, group?}]; onChange(value, option)
 */
export function Combo({ value, onChange, options = [], placeholder = 'Select…', onCreate, createLabel = '+ New', disabled, className = '', clearable = true }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef();
  const cur = options.find((o) => String(o.value) === String(value));
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return options.filter((o) => !s || `${o.label} ${o.sub || ''}`.toLowerCase().includes(s)).slice(0, 200);
  }, [q, options]);
  const pick = (o) => { onChange(o ? o.value : '', o); setOpen(false); setQ(''); };
  let lastGroup = null;
  return (
    <div className={`combo ${className} ${disabled ? 'disabled' : ''}`} ref={ref}>
      <div className="combo-input input" onClick={() => !disabled && setOpen(true)}>
        {open
          ? <input autoFocus value={q} placeholder={cur?.label || placeholder} onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { setHi((h) => Math.min(h + 1, filtered.length - 1)); e.preventDefault(); }
                if (e.key === 'ArrowUp') { setHi((h) => Math.max(h - 1, 0)); e.preventDefault(); }
                if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]); }
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Tab') setOpen(false);
              }} />
          : <span className={cur ? '' : 'muted'}>{cur?.label || placeholder}</span>}
        {clearable && cur && !disabled && !open && <button type="button" className="combo-clear" onClick={(e) => { e.stopPropagation(); pick(null); }}>×</button>}
        <span className="combo-caret">▾</span>
      </div>
      {open && (
        <div className="combo-list">
          {filtered.map((o, i) => {
            const g = o.group && o.group !== lastGroup ? (lastGroup = o.group) : null;
            return (
              <div key={`${o.value}-${i}`}>
                {g && <div className="combo-group">{g}</div>}
                <div className={`combo-opt ${i === hi ? 'hi' : ''} ${String(o.value) === String(value) ? 'sel' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
                  <div>{o.label}</div>{o.sub && <div className="muted small">{o.sub}</div>}
                </div>
              </div>
            );
          })}
          {!filtered.length && <div className="combo-opt muted">No matches</div>}
          {onCreate && <div className="combo-opt combo-create" onMouseDown={(e) => { e.preventDefault(); setOpen(false); onCreate(q); }}>{createLabel}{q ? ` "${q}"` : ''}</div>}
        </div>
      )}
    </div>
  );
}

/** Account picker grouped by account type. filter: array of account types or fn(account) */
export function AccountSelect({ value, onChange, filter, placeholder = 'Select an account', ...p }) {
  const { meta } = useApp();
  const opts = useMemo(() => (meta?.accounts || [])
    .filter((a) => a.is_active && (!filter || (Array.isArray(filter) ? filter.includes(a.type) : filter(a))))
    .map((a) => ({ value: a.id, label: a.name, sub: a.code, group: ACCOUNT_TYPE_LABELS[a.type] || a.type }))
    .sort((x, y) => x.group.localeCompare(y.group)), [meta, filter]);
  return <Combo value={value} onChange={onChange} options={opts} placeholder={placeholder} {...p} />;
}

export function TaxSelect({ value, onChange, placeholder = 'Tax', ...p }) {
  const { meta } = useApp();
  const opts = (meta?.taxes || []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: `${t.name}${t.kind !== 'group' ? ` [${t.rate}%]` : ' (group)'}` }));
  return <Combo value={value} onChange={onChange} options={opts} placeholder={placeholder} {...p} />;
}

export function useConfirm() {
  return (msg) => window.confirm(msg);
}

export function KeyValue({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function Stat({ label, value, sub, tone }) {
  return <div className={`stat ${tone ? `stat-${tone}` : ''}`}><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>;
}

/** Toolbar search box with debounce. */
export function SearchBox({ value, onChange, placeholder = 'Search' }) {
  const [v, setV] = useState(value || '');
  useEffect(() => { const t = setTimeout(() => v !== (value || '') && onChange(v), 300); return () => clearTimeout(t); }, [v]); // eslint-disable-line
  return <input className="input search" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />;
}

export function errorMessage(e) { return e?.message || 'Something went wrong'; }
