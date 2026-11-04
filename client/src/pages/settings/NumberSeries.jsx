import { useEffect, useState } from 'react';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Field, Input, NumberInput, Card, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const SERIES_LABELS = {
  quote: 'Quotes', salesorder: 'Sales Orders', invoice: 'Invoices', retainer: 'Retainer Invoices', creditnote: 'Credit Notes',
  deliverychallan: 'Delivery Challans', salesreceipt: 'Sales Receipts', recurring_invoice: 'Recurring Invoices',
  purchaseorder: 'Purchase Orders', bill: 'Bills', vendorcredit: 'Vendor Credits', recurring_bill: 'Recurring Bills',
  payment_received: 'Payments Received', payment_made: 'Payments Made', journal: 'Manual Journals',
};

export default function NumberSeries() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [series, setSeries] = useState(null);
  const [padding, setPadding] = useState(5);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setSeries(structuredClone(settings.series || {}));
    setPadding(settings.number_padding || 5);
  }, [settings]);

  if (!series) return <SettingsPage title="Transaction number series"><div className="muted">Loading…</div></SettingsPage>;

  const setRow = (key, patch) => setSeries((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const preview = (cfg) => `${cfg.prefix || ''}${String(Number(cfg.next) || 1).padStart(Number(padding) || 5, '0')}`;

  const save = async () => {
    setSaving(true);
    const body = { series: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, { prefix: v.prefix || '', next: Number(v.next) || 1 }])), number_padding: Number(padding) || 5 };
    const out = await attempt(toast, () => api.put('/org/settings', body), 'Number series saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  const keys = Object.keys(SERIES_LABELS).filter((k) => series[k]);
  const columns = [
    { key: 'label', label: 'Transaction', render: (r) => <span className="bold">{r.label}</span> },
    { key: 'prefix', label: 'Prefix', render: (r) => (
      <Input value={r.cfg.prefix || ''} disabled={!canEdit} maxLength={20} onChange={(e) => setRow(r.key, { prefix: e.target.value })} />
    ) },
    { key: 'next', label: 'Next number', render: (r) => (
      <NumberInput value={r.cfg.next ?? 1} min={1} disabled={!canEdit} onChange={(v) => setRow(r.key, { next: v })} />
    ) },
    { key: 'preview', label: 'Next transaction', render: (r) => <span className="muted num">{preview(r.cfg)}</span> },
  ];
  const rows = keys.map((k) => ({ id: k, key: k, label: SERIES_LABELS[k], cfg: series[k] }));

  return (
    <SettingsPage
      title="Transaction number series"
      subtitle="Prefix and next number for each kind of transaction."
      actions={canEdit && <Button variant="primary" loading={saving} onClick={save}>Save</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={rows} rowKey="id" />
      </Card>
      <div className="form-section" style={{ marginTop: 16 }}>
        <div className="form-grid">
          <Field label="Number padding" hint="How many digits the number has, e.g. 5 gives 00001.">
            <NumberInput value={padding} min={1} max={10} disabled={!canEdit} onChange={(v) => setPadding(v)} />
          </Field>
        </div>
      </div>
      <Note>Changing a next number does not renumber existing transactions. Make sure the new number is not already used.</Note>
    </SettingsPage>
  );
}
