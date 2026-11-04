import { useState } from 'react';
import { useApp } from '../../store.jsx';
import { Button, Card } from '../../components/ui.jsx';
import { SettingsPage, attempt, download, Note } from './common.jsx';

const EXPORTS = [
  ['contacts', 'Contacts'], ['items', 'Items'], ['invoices', 'Invoices'], ['bills', 'Bills'], ['expenses', 'Expenses'],
  ['payments', 'Payments'], ['accounts', 'Chart of accounts and balances'], ['journals', 'Journal entries'],
];

export default function DataBackup() {
  const { org, toast, can } = useApp();
  const [busy, setBusy] = useState(null);
  const canExport = can('settings', 'view');
  const stamp = new Date().toISOString().slice(0, 10);

  const run = async (key, fn) => {
    setBusy(key);
    await attempt(toast, fn, null);
    setBusy(null);
  };

  return (
    <SettingsPage title="Backup and export" subtitle={`Copies of the data for ${org?.name || 'this organization'}.`}>
      <Card title="Full backup" className="" >
        <p className="muted">A JSON file with every record of this organization: contacts, documents, payments, ledger entries, settings and more. Keep it somewhere safe.</p>
        <Button variant="primary" disabled={!canExport || busy === 'backup'} loading={busy === 'backup'}
          onClick={() => run('backup', () => download('/data/backup', `openbooks-backup-${stamp}.json`))}>
          Download backup (JSON)
        </Button>
        <Note>User accounts and passwords are not included. Only this organization's data is.</Note>
      </Card>

      <div style={{ height: 16 }} />

      <Card title="Export to CSV">
        <p className="muted">Spreadsheet-ready files for working outside OpenBooks.</p>
        <div className="grid3">
          {EXPORTS.map(([entity, label]) => (
            <div key={entity} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line2)' }}>
              <span>{label}</span>
              <Button size="sm" disabled={!canExport || busy === entity} loading={busy === entity}
                onClick={() => run(entity, () => download(`/data/export/${entity}?format=csv`, `${entity}-${stamp}.csv`))}>
                Download CSV
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </SettingsPage>
  );
}
