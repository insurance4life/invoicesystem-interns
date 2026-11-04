import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api, downloadCsv } from '../../api.js';
import { PageHeader, Button, Table, Badge, Select, SearchBox } from '../../components/ui.jsx';
import ImportDialog from './ImportDialog.jsx';

export const CONTACT_IMPORT_FIELDS = [
  { key: 'display_name', label: 'Display Name', required: true, aliases: ['name', 'customer name', 'vendor name'] },
  { key: 'company_name', label: 'Company Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'place_of_supply', label: 'Place of Supply' },
  { key: 'currency', label: 'Currency' },
  { key: 'billing_street', label: 'Billing Street' },
  { key: 'billing_city', label: 'Billing City' },
  { key: 'billing_state', label: 'Billing State' },
  { key: 'billing_zip', label: 'Billing ZIP' },
  { key: 'opening_balance', label: 'Opening Balance' },
  { key: 'opening_balance_date', label: 'Opening Balance Date' },
];

export default function ContactList({ type }) {
  const isCust = type === 'customer';
  const slug = isCust ? 'customers' : 'vendors';
  const label = isCust ? 'customer' : 'vendor';
  const { money, can, toast } = useApp();
  const nav = useNavigate();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState([]);
  const [importing, setImporting] = useState(false);
  const { data, loading, reload } = useFetch('/contacts', { type, status, q, per_page: 1000 }, [type]);
  const rows = data || [];
  const module = 'contacts';

  const bulk = async (action) => {
    if (action === 'delete' && !window.confirm(`Delete ${selected.length} ${label}(s)? Contacts with transactions cannot be deleted.`)) return;
    try {
      const res = await api.post('/contacts/bulk', { ids: selected, action });
      if (res.failed.length) toast(`${res.done} updated, ${res.failed.length} failed: ${res.failed[0].error}`, 'error');
      else toast(`${res.done} ${label}${res.done === 1 ? '' : 's'} updated`);
    } catch (e) { toast(e.message, 'error'); }
    setSelected([]);
    reload();
  };

  const cols = [
    { key: 'display_name', label: 'Name', render: (r) => <span className="bold">{r.display_name}</span> },
    { key: 'company_name', label: 'Company' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'outstanding', label: isCust ? 'Receivables' : 'Payables', align: 'right', render: (r) => money(r.outstanding, r.currency) },
    { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> },
  ];

  return (
    <div className="page">
      <PageHeader title={isCust ? 'Customers' : 'Vendors'}
        actions={<>
          {can(module, 'create') && <Button onClick={() => setImporting(true)}>Import</Button>}
          <Button onClick={() => downloadCsv(slug, rows, [
            { key: 'display_name', label: 'Name' }, { key: 'company_name', label: 'Company' }, { key: 'email', label: 'Email' },
            { key: 'phone', label: 'Phone' }, { key: 'gstin', label: 'GSTIN' }, { key: 'place_of_supply', label: 'Place of Supply' },
            { key: 'currency', label: 'Currency' }, { key: 'outstanding', label: isCust ? 'Receivables' : 'Payables' },
            { key: 'is_active', label: 'Active', value: (r) => (r.is_active ? 'Yes' : 'No') },
          ])}>Export CSV</Button>
          {can(module, 'create') && <Button variant="primary" onClick={() => nav(`/${slug}/new`)}>+ New {isCust ? 'Customer' : 'Vendor'}</Button>}
        </>}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="filter-select"
          options={[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']]} />
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${label}s by name, company, email, phone, GSTIN`} />
      </PageHeader>

      {selected.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="bold">{selected.length} selected</span>
          <Button size="sm" onClick={() => bulk('activate')}>Mark as Active</Button>
          <Button size="sm" onClick={() => bulk('deactivate')}>Mark as Inactive</Button>
          {can(module, 'delete') && <Button size="sm" variant="danger" onClick={() => bulk('delete')}>Delete</Button>}
        </div>
      )}

      <Table columns={cols} rows={rows} loading={loading} selectable selected={selected} onSelect={setSelected}
        onRowClick={(r) => nav(`/${slug}/${r.id}`)}
        empty={`No ${label}s found. ${can(module, 'create') ? `Create a ${label} or import a CSV file.` : ''}`} />

      {importing && (
        <ImportDialog title={isCust ? 'Customers' : 'Vendors'} fields={CONTACT_IMPORT_FIELDS} endpoint="/contacts/import"
          extra={{ type: isCust ? 'customer' : 'vendor' }} onClose={() => setImporting(false)} onDone={() => reload()} />
      )}
    </div>
  );
}
