import { useEffect, useState } from 'react';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Checkbox, Field, Input, NumberInput, Select, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt } from './common.jsx';

const DISCOUNT_LEVELS = [['transaction', 'At transaction level'], ['line', 'At line item level'], ['none', 'No discounts']];
const WEIGHT_UNITS = [['kg', 'Kilogram (kg)'], ['g', 'Gram (g)'], ['lb', 'Pound (lb)']];

export default function Preferences() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [p, setP] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (settings?.preferences) setP(structuredClone(settings.preferences)); }, [settings]);

  if (!p) return <SettingsPage title="Preferences"><div className="muted">Loading…</div></SettingsPage>;

  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const setLate = (k, v) => setP((x) => ({ ...x, late_fee: { ...x.late_fee, [k]: v } }));

  const save = async () => {
    setSaving(true);
    const body = {
      ...p,
      quote_validity_days: Number(p.quote_validity_days) || 0,
      decimal_places: Number(p.decimal_places),
      late_fee: { ...p.late_fee, value: Number(p.late_fee.value) || 0, after_days: Number(p.late_fee.after_days) || 0 },
    };
    const out = await attempt(toast, () => api.put('/org/settings', { preferences: body }), 'Preferences saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  return (
    <SettingsPage title="Preferences" subtitle="Defaults for new transactions and how amounts are handled.">
      <div className="form-section">
        <h3>Discounts, taxes and charges</h3>
        <div className="form-grid">
          <Field label="Discount">
            <Select options={DISCOUNT_LEVELS} value={p.discount_level} disabled={!canEdit} onChange={(e) => set('discount_level', e.target.value)} />
          </Field>
          <div className="stack">
            <Checkbox label="Allow shipping charges" checked={p.allow_shipping} disabled={!canEdit} onChange={(v) => set('allow_shipping', v)} />
            <Checkbox label="Allow adjustments" checked={p.allow_adjustment} disabled={!canEdit} onChange={(v) => set('allow_adjustment', v)} />
            <Checkbox label="Rates are tax inclusive by default" checked={p.tax_inclusive_default} disabled={!canEdit} onChange={(v) => set('tax_inclusive_default', v)} />
            <Checkbox label="Allow editing sent invoices" checked={p.allow_editing_sent_invoice} disabled={!canEdit} onChange={(v) => set('allow_editing_sent_invoice', v)} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <h3>Default terms and notes</h3>
        <div className="form-grid">
          <Field label="Invoice terms"><Textarea rows={3} value={p.invoice_terms} disabled={!canEdit} onChange={(e) => set('invoice_terms', e.target.value)} /></Field>
          <Field label="Invoice notes"><Textarea rows={3} value={p.invoice_notes} disabled={!canEdit} onChange={(e) => set('invoice_notes', e.target.value)} /></Field>
          <Field label="Quote terms"><Textarea rows={3} value={p.quote_terms} disabled={!canEdit} onChange={(e) => set('quote_terms', e.target.value)} /></Field>
          <Field label="Sales order terms"><Textarea rows={3} value={p.so_terms} disabled={!canEdit} onChange={(e) => set('so_terms', e.target.value)} /></Field>
          <Field label="Purchase order terms"><Textarea rows={3} value={p.po_terms} disabled={!canEdit} onChange={(e) => set('po_terms', e.target.value)} /></Field>
          <Field label="Bill notes"><Textarea rows={3} value={p.bill_notes} disabled={!canEdit} onChange={(e) => set('bill_notes', e.target.value)} /></Field>
          <Field label="Quote validity (days)">
            <NumberInput value={p.quote_validity_days} disabled={!canEdit} onChange={(v) => set('quote_validity_days', v)} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Late fee</h3>
        <div className="form-grid">
          <div className="stack">
            <Checkbox label="Charge a late fee on overdue invoices" checked={p.late_fee.enabled} disabled={!canEdit} onChange={(v) => setLate('enabled', v)} />
          </div>
          <div />
          <Field label="Fee type">
            <Select options={[['percent', 'Percentage of balance'], ['amount', 'Fixed amount']]} value={p.late_fee.type} disabled={!canEdit} onChange={(e) => setLate('type', e.target.value)} />
          </Field>
          <Field label="Fee value">
            <NumberInput value={p.late_fee.value} disabled={!canEdit} onChange={(v) => setLate('value', v)} />
          </Field>
          <Field label="Apply after (days overdue)">
            <NumberInput value={p.late_fee.after_days} disabled={!canEdit} onChange={(v) => setLate('after_days', v)} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Inventory, numbers and checks</h3>
        <div className="form-grid">
          <Field label="Inventory start date" hint="Stock is tracked from this date.">
            <Input type="date" value={p.inventory_start_date || ''} disabled={!canEdit} onChange={(e) => set('inventory_start_date', e.target.value || null)} />
          </Field>
          <Field label="Decimal places">
            <Select options={[0, 1, 2, 3, 4].map((n) => [n, String(n)])} value={p.decimal_places} disabled={!canEdit} onChange={(e) => set('decimal_places', Number(e.target.value))} />
          </Field>
          <Field label="Weight unit">
            <Select options={WEIGHT_UNITS} value={p.weight_unit} disabled={!canEdit} onChange={(e) => set('weight_unit', e.target.value)} />
          </Field>
          <div className="stack">
            <Checkbox label="Warn about duplicate item SKUs" checked={p.duplicate_sku_check} disabled={!canEdit} onChange={(v) => set('duplicate_sku_check', v)} />
            <Checkbox label="Warn about duplicate contacts" checked={p.duplicate_contact_check} disabled={!canEdit} onChange={(v) => set('duplicate_contact_check', v)} />
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save preferences</Button>
        </div>
      )}
    </SettingsPage>
  );
}
