import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, NumberInput, Select, Combo, AccountSelect, Spinner, Textarea } from '../../components/ui.jsx';
import { today } from '../../lib/format.js';
import { round2 } from '@shared/calc.js';
import { errText, num } from './common.js';

let keySeq = 1;
const blank = () => ({ key: keySeq++, account_id: '', contact_id: '', description: '', debit: '', credit: '' });
const FREQ = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];

/**
 * Manual journal form. profile = true turns it into a recurring-journal profile.
 * Routes: journals/new (?clone=ID or a template picked from the list), journals/:id/edit.
 */
export default function JournalForm({ profile = false }) {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { meta, org, toast, can } = useApp();
  const base = org?.currency;
  const [f, setF] = useState(() => ({
    date: today(), number: '', reference: '', notes: '', currency: base, exchange_rate: 1, reverse_date: '',
    frequency: 'monthly', every: 1, end_date: '',
  }));
  const [lines, setLines] = useState(() => [blank(), blank()]);
  const [contacts, setContacts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [current, setCurrent] = useState(null);
  const [loading, setLoading] = useState(!!(id || sp.get('clone')));
  const [saving, setSaving] = useState(null);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  useEffect(() => {
    api.get('/contacts', { per_page: 500 }).then(setContacts).catch(() => {});
    if (!id && !profile) api.get('/journals', { type: 'template' }).then(setTemplates).catch(() => {});
    const src = id || sp.get('clone');
    if (!src) return setLoading(false);
    api.get(`/journals/${src}`).then((j) => {
      setCurrent(id ? j : null);
      setF((x) => ({
        ...x, date: id ? j.date : today(), number: id ? j.number : '', reference: j.reference || '', notes: j.notes || '',
        currency: j.currency || base, exchange_rate: j.exchange_rate || 1, reverse_date: id ? (j.reverse_date || '') : '',
        frequency: j.recurrence?.frequency || 'monthly', every: j.recurrence?.every || 1, end_date: j.recurrence?.end_date || '',
      }));
      setLines(j.lines.map((l) => ({ key: keySeq++, account_id: l.account_id, contact_id: l.contact_id || '', description: l.description || '', debit: l.debit || '', credit: l.credit || '' })));
    }).catch((e) => toast(errText(e), 'error')).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const applyTemplate = async (tid) => {
    if (!tid) return;
    try {
      const t = await api.get(`/journals/${tid}`);
      setF((x) => ({ ...x, reference: t.reference || x.reference, notes: t.notes || x.notes, currency: t.currency || x.currency, exchange_rate: t.exchange_rate || 1 }));
      setLines(t.lines.map((l) => ({ key: keySeq++, account_id: l.account_id, contact_id: l.contact_id || '', description: l.description || '', debit: l.debit || '', credit: l.credit || '' })));
    } catch (e) { toast(errText(e), 'error'); }
  };

  const totals = useMemo(() => {
    const d = round2(lines.reduce((s, l) => s + num(l.debit), 0));
    const c = round2(lines.reduce((s, l) => s + num(l.credit), 0));
    return { debit: d, credit: c, diff: round2(d - c) };
  }, [lines]);

  const contactOpts = useMemo(() => contacts.map((c) => ({ value: c.id, label: c.display_name, sub: c.type === 'vendor' ? 'Vendor' : 'Customer' })), [contacts]);
  const currencies = (meta?.currencies || []).filter((c) => !c.is_base);
  const isForeign = !!f.currency && f.currency !== base;

  const onCurrency = (code) => {
    const c = (meta?.currencies || []).find((x) => x.code === code);
    setF((x) => ({ ...x, currency: code, exchange_rate: code === base ? 1 : (c?.exchange_rate || 1) }));
  };

  const save = async (mode) => {
    // mode: 'draft' | 'published' | 'template'
    const used = lines.filter((l) => l.account_id && (num(l.debit) || num(l.credit)));
    if (lines.some((l) => !l.account_id && (num(l.debit) || num(l.credit)))) return toast('Every line with an amount needs an account', 'error');
    if (used.length < 2) return toast('A journal needs at least two lines', 'error');
    if (totals.diff !== 0) return toast(`Debits (${totals.debit.toFixed(2)}) and credits (${totals.credit.toFixed(2)}) must be equal`, 'error');
    if (!f.date) return toast('Date is required', 'error');

    const body = {
      date: f.date, reference: f.reference || null, notes: f.notes || null, currency: f.currency || base,
      exchange_rate: isForeign ? num(f.exchange_rate) || 1 : 1,
      reverse_date: profile ? null : (f.reverse_date || null),
      status: mode === 'draft' ? 'draft' : 'published',
      journal_type: mode === 'template' ? 'template' : 'manual',
      is_profile: profile ? 1 : 0,
      lines: used.map((l) => ({ account_id: Number(l.account_id), contact_id: l.contact_id ? Number(l.contact_id) : null, description: l.description || null, debit: num(l.debit), credit: num(l.credit) })),
    };
    if (profile) body.recurrence = { frequency: f.frequency, every: Number(f.every) || 1, start_date: f.date, end_date: f.end_date || null };
    if (!id && f.number) body.number = f.number;

    setSaving(mode);
    try {
      const j = id ? await api.put(`/journals/${id}`, body) : await api.post('/journals', body);
      if (mode === 'template') { toast('Template saved'); return nav('/accountant/journals'); }
      toast(profile ? (id ? 'Recurring journal updated' : 'Recurring journal created') : mode === 'draft' ? 'Draft saved' : 'Journal published');
      nav(profile ? `/accountant/recurring-journals/${j.id}` : `/accountant/journals/${j.id}`);
    } catch (e) { toast(errText(e), 'error'); }
    setSaving(null);
  };

  if (loading) return <Spinner />;
  const title = profile ? (id ? 'Edit Recurring Journal' : 'New Recurring Journal') : (id ? `Edit Journal ${current?.number || ''}` : (sp.get('clone') ? 'Clone Journal' : 'New Journal'));
  const canEdit = id ? can('accountant', 'edit') : can('accountant', 'create');

  return (
    <div className="page">
      <PageHeader title={title} subtitle={profile ? 'Post the same journal automatically on a schedule.' : 'Debits and credits must balance.'}
        actions={!id && !profile && templates.length > 0 && (
          <Select style={{ width: 220 }} placeholder="Use a template" value="" options={templates.map((t) => [t.id, t.reference || t.notes || `Template ${t.id}`])} onChange={(e) => applyTemplate(e.target.value)} />
        )} />
      <div className="form-section">
        <div className="grid3">
          <Field label="Date" required>
            <Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
          {!profile && (
            <Field label="Journal #" hint={id ? 'Numbers are fixed once created.' : 'Leave blank to use the next number.'}>
              <Input value={id ? (current?.number || '') : f.number} disabled={!!id} placeholder={id ? '' : 'Auto'} onChange={(e) => set('number', e.target.value)} />
            </Field>
          )}
          <Field label="Reference #">
            <Input value={f.reference} onChange={(e) => set('reference', e.target.value)} />
          </Field>
          <Field label="Currency">
            <Select value={f.currency} onChange={(e) => onCurrency(e.target.value)}
              options={(meta?.currencies || []).length ? (meta.currencies.map((c) => [c.code, `${c.code}${c.name ? ` – ${c.name}` : ''}`])) : [[base, base]]} />
          </Field>
          {isForeign && (
            <Field label={`Exchange rate (${base} per 1 ${f.currency})`}>
              <NumberInput value={f.exchange_rate} onChange={(v) => set('exchange_rate', v)} />
            </Field>
          )}
          {profile ? (
            <>
              <Field label="Repeat">
                <Select value={f.frequency} onChange={(e) => set('frequency', e.target.value)} options={FREQ} />
              </Field>
              <Field label="Every">
                <NumberInput value={f.every} onChange={(v) => set('every', v)} />
              </Field>
              <Field label="End date" hint="Optional. Leave blank to run until stopped.">
                <Input type="date" value={f.end_date} onChange={(e) => set('end_date', e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="Reverse on" hint="Creates a reversing journal on this date. Leave blank for none.">
              <Input type="date" value={f.reverse_date} onChange={(e) => set('reverse_date', e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Notes" className="mt"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>

      <div className="form-section">
        <h3 className="mb">Line Items</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="lines-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Account</th>
                <th style={{ minWidth: 160 }}>Contact</th>
                <th style={{ minWidth: 180 }}>Description</th>
                <th style={{ width: 130 }} className="r">Debit</th>
                <th style={{ width: 130 }} className="r">Credit</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><AccountSelect value={l.account_id} onChange={(v) => setLine(l.key, { account_id: v })} /></td>
                  <td><Combo value={l.contact_id} options={contactOpts} placeholder="Optional" onChange={(v) => setLine(l.key, { contact_id: v })} /></td>
                  <td><Input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
                  <td><NumberInput value={l.debit} onChange={(v) => setLine(l.key, { debit: v, ...(num(v) ? { credit: '' } : {}) })} /></td>
                  <td><NumberInput value={l.credit} onChange={(v) => setLine(l.key, { credit: v, ...(num(v) ? { debit: '' } : {}) })} /></td>
                  <td><button className="icon-btn rm" title="Remove line" onClick={() => setLines((ls) => (ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls))}>×</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td colSpan={3} className="r bold">Total</td>
                <td className="r bold">{totals.debit.toFixed(2)}</td>
                <td className="r bold">{totals.credit.toFixed(2)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={3} className="r">Difference</td>
                <td colSpan={2} className="r bold" style={{ color: totals.diff ? 'var(--red)' : 'var(--green)' }}>
                  {totals.diff ? `Out of balance by ${Math.abs(totals.diff).toFixed(2)}` : 'Balanced'}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row mt">
          <Button size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>+ Add Line</Button>
        </div>
      </div>

      {canEdit && (
        <div className="form-foot">
          {profile ? (
            <Button variant="primary" loading={saving === 'published'} onClick={() => save('published')}>Save Recurring Journal</Button>
          ) : (
            <>
              <Button loading={saving === 'draft'} onClick={() => save('draft')}>Save as Draft</Button>
              <Button variant="primary" loading={saving === 'published'} onClick={() => save('published')}>Save and Publish</Button>
              {!id && <Button loading={saving === 'template'} onClick={() => save('template')}>Save as Template</Button>}
            </>
          )}
          <Button onClick={() => nav(-1)}>Cancel</Button>
          {id && <Link className="muted small" style={{ marginLeft: 'auto', alignSelf: 'center' }} to={profile ? `/accountant/recurring-journals/${id}` : `/accountant/journals/${id}`}>View journal</Link>}
        </div>
      )}
    </div>
  );
}
