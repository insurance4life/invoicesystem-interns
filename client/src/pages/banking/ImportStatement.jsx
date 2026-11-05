import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api, parseCsv } from '../../api.js';
import { PageHeader, Button, Field, Select, AccountSelect, Table, Checkbox, Card } from '../../components/ui.jsx';
import { bankFilter } from './common.jsx';

const FIELDS = [
  ['date', 'Date', true], ['description', 'Description', false], ['deposit', 'Deposits (credit)', false], ['withdrawal', 'Withdrawals (debit)', false],
  ['amount', 'Amount (signed)', false], ['reference', 'Reference / Cheque#', false], ['payee', 'Payee', false], ['balance', 'Balance', false],
];
const GUESS = {
  date: /^(txn |transaction |value |posting )?date$|^date/i, description: /desc|narration|particular|details|memo|remarks/i,
  deposit: /deposit|credit|cr\b|money in|paid in/i, withdrawal: /withdraw|debit|dr\b|money out|paid out/i, amount: /^amount$|^amt$|txn amount/i,
  reference: /ref|chq|cheque|check|utr/i, payee: /payee|name|party/i, balance: /balance|bal\b/i,
};

/** OFX / QFX statement → rows */
export function parseOfx(text) {
  const rows = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i')); return m ? m[1].trim() : ''; };
  for (const b of blocks) {
    const d = tag(b, 'DTPOSTED');
    rows.push({ date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '', amount: tag(b, 'TRNAMT'), description: tag(b, 'MEMO') || tag(b, 'NAME'), payee: tag(b, 'NAME'), reference: tag(b, 'CHECKNUM') || tag(b, 'REFNUM') || tag(b, 'FITID') });
  }
  return rows;
}

/** QIF statement → rows */
export function parseQif(text) {
  const rows = [];
  let cur = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    const k = line[0], v = line.slice(1).trim();
    if (k === '^') { if (cur.date) rows.push(cur); cur = {}; continue; }
    if (k === 'D') cur.date = v.replace(/'/g, '/');
    if (k === 'T' || k === 'U') cur.amount = v;
    if (k === 'P') { cur.payee = v; cur.description = cur.description || v; }
    if (k === 'M') cur.description = v;
    if (k === 'N') cur.reference = v;
  }
  if (cur.date) rows.push(cur);
  return rows;
}

// lightweight client-side preview of the server's parsing
function previewDate(v, fmt) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const [d, mo] = fmt === 'mdy' ? [m[2], m[1]] : [m[1], m[2]];
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return s ? `? ${s}` : '';
}
const num = (v) => { if (v == null || v === '') return 0; let s = String(v).trim(); const neg = /^\(.*\)$/.test(s) || /\bDR\b/i.test(s); s = s.replace(/[^0-9.-]/g, ''); const n = Number(s) || 0; return neg ? -Math.abs(n) : n; };

export default function ImportStatement() {
  const { id } = useParams();
  const nav = useNavigate();
  const { toast, money } = useApp();
  const [accountId, setAccountId] = useState(id ? Number(id) : '');
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState('');
  const [kind, setKind] = useState('csv');
  const [raw, setRaw] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [map, setMap] = useState({});
  const [fmt, setFmt] = useState('dmy');
  const [invert, setInvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    const ext = file.name.split('.').pop().toLowerCase();
    let rows, k = 'csv';
    if (['ofx', 'qfx'].includes(ext) || /<OFX>/i.test(text)) { rows = parseOfx(text); k = 'ofx'; }
    else if (ext === 'qif' || /^!Type:/im.test(text)) { rows = parseQif(text); k = 'qif'; }
    else rows = parseCsv(text);
    if (!rows.length) { toast('No transactions found in this file', 'error'); return; }
    const hs = Object.keys(rows[0]);
    const m = {};
    if (k === 'csv') {
      for (const [f] of FIELDS) {
        const h = hs.find((x) => GUESS[f].test(x) && !Object.values(m).includes(x));
        if (h) m[f] = h;
      }
      if (m.amount && (m.deposit || m.withdrawal)) delete m.amount;
    } else for (const [f] of FIELDS) if (hs.includes(f)) m[f] = f;
    setKind(k); setRaw(rows); setHeaders(hs); setMap(m);
    setFmt(k === 'qif' ? 'mdy' : 'dmy');
    setStep(k === 'csv' ? 2 : 3);
  };

  const mapped = useMemo(() => raw.map((r) => Object.fromEntries(FIELDS.map(([f]) => [f, map[f] ? r[map[f]] : undefined]))), [raw, map]);
  const preview = mapped.slice(0, 50).map((r, i) => {
    let amt = r.amount !== undefined && r.amount !== '' ? num(r.amount) : Math.abs(num(r.deposit)) - Math.abs(num(r.withdrawal));
    if (invert) amt = -amt;
    return { i, date: previewDate(r.date, fmt), description: r.description, reference: r.reference, amount: amt };
  });

  const doImport = async () => {
    if (!accountId) return toast('Choose the account to import into', 'error');
    setBusy(true);
    try {
      const res = await api.post(`/banking/accounts/${accountId}/import`, { rows: mapped, date_format: fmt, invert });
      setResult(res);
      setStep(4);
      toast(`${res.imported} transactions imported`);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };

  const mappingOk = map.date && (map.amount || map.deposit || map.withdrawal);
  const hopts = headers.map((h) => [h, h]);

  return (
    <div className="page">
      <PageHeader title="Import Statement" back={<Button variant="link" onClick={() => nav(id ? `/banking/accounts/${id}` : '/banking')}>←</Button>}>
        <div className="bk-steps">
          {['Upload', 'Map Fields', 'Preview', 'Done'].map((s, i) => <span key={s} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}>{i + 1}. {s}</span>)}
        </div>
      </PageHeader>

      {step === 1 && (
        <div className="form-section">
          <div className="form-grid">
            <Field label="Account" required><AccountSelect value={accountId} onChange={setAccountId} filter={bankFilter} /></Field>
            <Field label="Statement File" required hint="CSV (with a header row), OFX / QFX or QIF. Maximum 5 MB.">
              <input type="file" accept=".csv,.txt,.ofx,.qfx,.qif" onChange={onFile} disabled={!accountId} />
            </Field>
          </div>
          {!accountId && <p className="muted small">Choose an account first.</p>}
        </div>
      )}

      {step === 2 && (
        <div className="form-section">
          <p className="muted">Map the columns of <b>{fileName}</b> ({raw.length} rows) to BeyondBooks fields. Use either Amount (negative for withdrawals) or separate Deposit / Withdrawal columns.</p>
          <div className="form-grid">
            {FIELDS.map(([f, label, req]) => (
              <Field key={f} label={label} required={req} inline>
                <Select value={map[f] || ''} placeholder="— not mapped —" options={hopts} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value || undefined }))} />
              </Field>
            ))}
            <Field label="Date Format" inline><Select value={fmt} options={[['dmy', 'dd/MM/yyyy'], ['mdy', 'MM/dd/yyyy'], ['ymd', 'yyyy-MM-dd']]} onChange={(e) => setFmt(e.target.value)} /></Field>
            <Field label=" " inline><Checkbox label="Amounts are reversed (withdrawals positive)" checked={invert} onChange={setInvert} /></Field>
          </div>
          <div className="row mt">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" disabled={!mappingOk} onClick={() => setStep(3)}>Next</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <div className="callout">
            <span>{raw.length} transactions from <b>{fileName}</b> ({kind.toUpperCase()}). Duplicates (same date, amount and description) are skipped and bank rules are applied automatically.</span>
            <div className="row">
              {kind !== 'csv' && <Select value={fmt} options={[['dmy', 'dd/MM/yyyy'], ['mdy', 'MM/dd/yyyy']]} onChange={(e) => setFmt(e.target.value)} />}
              <Button onClick={() => setStep(kind === 'csv' ? 2 : 1)}>Back</Button>
              <Button variant="primary" loading={busy} onClick={doImport}>Import</Button>
            </div>
          </div>
          <Table rowKey="i" rows={preview} columns={[
            { key: 'date', label: 'Date', render: (r) => (r.date.startsWith('?') ? <span className="neg">{r.date}</span> : r.date) },
            { key: 'description', label: 'Description' },
            { key: 'reference', label: 'Reference' },
            { key: 'dep', label: 'Deposit', align: 'right', render: (r) => (r.amount > 0 ? money(r.amount) : '') },
            { key: 'wd', label: 'Withdrawal', align: 'right', render: (r) => (r.amount < 0 ? money(-r.amount) : '') },
          ]} />
          {raw.length > 50 && <p className="muted small">Showing the first 50 of {raw.length} rows.</p>}
        </div>
      )}

      {step === 4 && result && (
        <Card title="Import complete">
          <ul>
            <li><b>{result.imported}</b> transactions imported</li>
            <li>{result.duplicates} duplicates skipped</li>
            {result.skipped > 0 && <li>{result.skipped} rows skipped</li>}
            <li>{result.categorized} auto-categorized and {result.suggested} suggested by bank rules</li>
          </ul>
          {result.errors?.length > 0 && <div className="muted small">{result.errors.slice(0, 10).map((e) => <div key={e}>{e}</div>)}</div>}
          <div className="row mt"><Button variant="primary" onClick={() => nav(`/banking/accounts/${accountId}`)}>Review Transactions</Button><Button onClick={() => { setStep(1); setResult(null); setRaw([]); }}>Import Another</Button></div>
        </Card>
      )}
    </div>
  );
}
