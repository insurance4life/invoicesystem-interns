import { useMemo, useState } from 'react';
import { api, parseCsv, downloadCsv } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Modal, Button, Select, Table } from '../../components/ui.jsx';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Generic CSV import: upload → map columns → preview → POST(endpoint, {...extra, rows, skip_duplicates}).
 * fields: [{key, label, required?, aliases?}] — keys are the field names the server expects.
 */
export default function ImportDialog({ title, fields, endpoint, extra = {}, onClose, onDone }) {
  const { toast } = useApp();
  const [step, setStep] = useState(1);
  const [headers, setHeaders] = useState([]);
  const [csv, setCsv] = useState([]);
  const [map, setMap] = useState({});
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const onFile = async (file) => {
    if (!file) return;
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) return toast('The file has no data rows', 'error');
      const hs = Object.keys(rows[0]);
      const auto = {};
      for (const f of fields) {
        auto[f.key] = hs.find((h) => [f.key, f.label, ...(f.aliases || [])].some((a) => norm(a) === norm(h))) || '';
      }
      setHeaders(hs);
      setCsv(rows);
      setMap(auto);
      setStep(2);
    } catch (e) { toast(e.message, 'error'); }
  };

  const mapped = useMemo(() => csv.map((r) => Object.fromEntries(fields.map((f) => [f.key, map[f.key] ? r[map[f.key]] ?? '' : '']))), [csv, map, fields]);
  const missing = fields.filter((f) => f.required && !map[f.key]);

  const doImport = async () => {
    setBusy(true);
    try {
      const res = await api.post(endpoint, { ...extra, rows: mapped, skip_duplicates: skip });
      setResult(res);
      setStep(4);
      if (res.created) onDone?.(res);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const template = () => downloadCsv(`${title} template`, [], fields.map((f) => ({ key: f.key, label: f.key })));

  const foot = (
    <>
      {step === 1 && <Button variant="link" onClick={template}>Download template</Button>}
      <span style={{ flex: 1 }} />
      {step === 2 && <><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={missing.length > 0} onClick={() => setStep(3)}>Next</Button></>}
      {step === 3 && <><Button onClick={() => setStep(2)}>Back</Button>
        <Button variant="primary" loading={busy} onClick={doImport}>Import {mapped.length} rows</Button></>}
      {(step === 1 || step === 4) && <Button variant={step === 4 ? 'primary' : 'secondary'} onClick={onClose}>{step === 4 ? 'Done' : 'Cancel'}</Button>}
    </>
  );

  return (
    <Modal title={`Import ${title}`} onClose={onClose} width={760} footer={foot}>
      {step === 1 && (
        <div className="stack">
          <p className="muted">Upload a CSV file with a header row. You will map its columns to fields in the next step.</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      )}

      {step === 2 && (
        <div className="stack">
          <p className="muted">{csv.length} rows found. Match each field to a column in your file.</p>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            {fields.map((f) => (
              <label key={f.key} className="field field-inline">
                <span className={`field-label ${f.required ? 'req' : ''}`}>{f.label}</span>
                <span className="field-control">
                  <Select value={map[f.key] || ''} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}
                    placeholder={f.required ? 'Choose a column' : '— not imported —'}
                    options={headers.map((h) => [h, h])} />
                </span>
              </label>
            ))}
          </div>
          {missing.length > 0 && <small className="field-error">Map: {missing.map((f) => f.label).join(', ')}</small>}
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <p className="muted">Preview of the first {Math.min(10, mapped.length)} of {mapped.length} rows.</p>
          <div style={{ overflow: 'auto', maxHeight: 320 }}>
            <Table columns={fields.filter((f) => map[f.key]).map((f) => ({ key: f.key, label: f.label }))}
              rows={mapped.slice(0, 10).map((r, i) => ({ ...r, id: i }))} />
          </div>
          <label className="checkbox"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /><span>Skip rows that already exist (same name{extra.type ? ' and type' : ''})</span></label>
        </div>
      )}

      {step === 4 && result && (
        <div className="stack">
          <div className="callout"><b>{result.created}</b> created · <b>{result.skipped ?? 0}</b> skipped · <b>{result.errors?.length || 0}</b> with errors</div>
          {result.errors?.length > 0 && (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              <Table columns={[{ key: 'row', label: 'Row', width: 70 }, { key: 'error', label: 'Problem' }]} rows={result.errors.slice(0, 200).map((e, i) => ({ ...e, id: i }))} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
