// Generic renderer for server report payloads: { columns:[{key,label,type}], rows:[...], totals }.
// Row hints from the server: _kind (section | total | grand), _indent (0-3), _link and id fields for drill-down.
import { Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { Badge } from '../../components/ui.jsx';
import { docUrl } from '../../lib/docs.js';
import { fmtNum } from '../../lib/format.js';

const DOC_SRC = ['invoice', 'creditnote', 'salesreceipt', 'bill', 'vendorcredit', 'quote', 'salesorder', 'purchaseorder', 'retainer', 'deliverychallan'];
const NUMERIC = ['money', 'num', 'pct'];

/** URL of the transaction behind a ledger line (src_type/src_id). */
export function sourceUrl(type, id) {
  if (!type || !id) return null;
  if (DOC_SRC.includes(type)) return docUrl(type, id);
  if (type === 'writeoff') return docUrl('invoice', id);
  if (type === 'payment_received') return `/payments-received/${id}`;
  if (type === 'payment_made') return `/payments-made/${id}`;
  if (type === 'expense') return `/expenses/${id}`;
  if (type === 'journal') return `/accountant/journals/${id}`;
  return null;
}

export function accountUrl(accountId, from, to) {
  const p = new URLSearchParams({ account_id: accountId });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return `/reports/account-transactions?${p}`;
}

function linkFor(col, r, range) {
  switch (col.type) {
    case 'account': {
      if (r._link === 'source') return sourceUrl(r.src_type, r.src_id);
      const id = r[col.idKey || 'account_id'];
      return id ? accountUrl(id, range.from, range.to) : null;
    }
    case 'doc':
      if (r.doc_type && r.doc_id) return docUrl(r.doc_type, r.doc_id);
      if (r.expense_id) return `/expenses/${r.expense_id}`;
      if (r.journal_id) return `/accountant/journals/${r.journal_id}`;
      return null;
    case 'source': return sourceUrl(r.src_type, r.src_id);
    case 'payment': return r.payment_id ? `/payments-${r.payment_type}/${r.payment_id}` : null;
    case 'expense': return r.expense_id ? `/expenses/${r.expense_id}` : null;
    case 'journal': return r.journal_id ? `/accountant/journals/${r.journal_id}` : null;
    case 'item': return r.item_id ? `/items/${r.item_id}` : null;
    default: return null;
  }
}

export function useCellFormat() {
  const { money, date } = useApp();
  return (col, v) => {
    if (v === null || v === undefined || v === '') return '';
    switch (col.type) {
      case 'money': return money(v);
      case 'num': return fmtNum(v, Number.isInteger(Number(v)) ? 0 : 2);
      case 'pct': return `${fmtNum(v, 2)}%`;
      case 'date': return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? date(v) : v;
      case 'datetime': return String(v).replace('T', ' ').slice(0, 19);
      default: return v;
    }
  };
}

export default function ReportTable({ columns = [], rows = [], totals, range = {}, empty = 'No data for the selected filters.', className = '' }) {
  const fmt = useCellFormat();
  const cell = (c, r) => {
    const v = r[c.key];
    if (c.type === 'status' && v && !r._kind) return <Badge status={v} />;
    const text = fmt(c, v);
    const url = ['total', 'grand'].includes(r._kind) ? null : linkFor(c, r, range);
    if (url && text !== '') return <Link to={url}>{text}</Link>;
    return text;
  };
  return (
    <div className={`table-wrap report-table ${className}`}>
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={NUMERIC.includes(c.type) ? 'r' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {!rows.length && <tr><td colSpan={columns.length} className="center muted pad">{empty}</td></tr>}
          {rows.map((r, i) => {
            const cls = [r._kind === 'section' && 'section-row', r._kind === 'total' && 'total-row', r._kind === 'grand' && 'total-row grand-row', r._indent && `indent${Math.min(r._indent, 3)}`].filter(Boolean).join(' ');
            if (r._kind === 'section' && columns.every((c, k) => k === 0 || r[c.key] == null)) {
              const first = columns[0];
              return <tr key={i} className={cls}><td colSpan={columns.length}>{cell(first, r) || r.name || r.date}</td></tr>;
            }
            return (
              <tr key={i} className={cls}>
                {columns.map((c, k) => <td key={c.key} className={NUMERIC.includes(c.type) ? 'r' : ''}>{k === 0 && r[c.key] == null && r._kind ? (r.name ?? r.description ?? r.date ?? '') : cell(c, r)}</td>)}
              </tr>
            );
          })}
        </tbody>
        {totals && rows.length > 0 && (
          <tfoot>
            <tr className="total-row">
              {columns.map((c, k) => <td key={c.key} className={NUMERIC.includes(c.type) ? 'r' : ''}>{k === 0 ? (typeof totals[c.key] === 'string' ? totals[c.key] : totals.name || 'Total') : (c.type === 'money' || c.type === 'num' ? fmt(c, totals[c.key]) : '')}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** CSV export columns, indenting the first column by the row's level. */
export function csvColumns(columns) {
  return columns.map((c, k) => ({ key: c.key, label: c.label, value: (r) => {
    const v = r[c.key] ?? (k === 0 && r._kind ? r.name ?? r.description ?? r.date : '');
    return k === 0 && r._indent ? `${'  '.repeat(r._indent)}${v ?? ''}` : v;
  } }));
}
