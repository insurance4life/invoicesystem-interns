import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Button, Badge, Combo, Field, Input, Menu, Modal, PageHeader, Select, Table, Tabs, errorMessage } from '../../components/ui.jsx';
import { downloadFile, fetchFileBlob, fmtSize, uploadFiles } from '../../components/Attachments.jsx';
import { Image, FileText } from 'lucide-react';

const FOLDERS = [
  ['all', 'All files'], ['inbox', 'Inbox'], ['receipts', 'Receipts'], ['bills', 'Bills'], ['contracts', 'Contracts'], ['others', 'Others'],
];
const FOLDER_LABEL = Object.fromEntries(FOLDERS);
const ENTITY = [['invoice', 'Invoice'], ['bill', 'Bill'], ['expense', 'Expense'], ['contact', 'Contact']];
const ENTITY_LABEL = Object.fromEntries(ENTITY);

const isImage = (m) => /^image\/(png|jpe?g|gif|webp)$/.test(m || '');
const isPdf = (m) => m === 'application/pdf';
const icon = (m, size = 16) => (isImage(m) ? <Image size={size} strokeWidth={1.5} /> : <FileText size={size} strokeWidth={1.5} />);

export default function DocumentsPage() {
  const { can, toast, date } = useApp();
  const [folder, setFolder] = useState('all');
  const [q, setQ] = useState('');
  const [view, setView] = useState('list');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [moving, setMoving] = useState(null);
  const [attaching, setAttaching] = useState(null);
  const inputRef = useRef(null);
  const files = useFetch('/files', { folder: folder === 'all' ? undefined : folder, q: q || undefined });
  const rows = files.data || [];
  const uploadFolder = folder === 'all' ? 'inbox' : folder;

  const upload = async (list) => {
    if (!list?.length) return;
    setBusy(true);
    const { ok, errors } = await uploadFiles(list, { folder: uploadFolder });
    errors.forEach((m) => toast(m, 'error'));
    if (ok) toast(`${ok} file${ok > 1 ? 's' : ''} uploaded to ${FOLDER_LABEL[uploadFolder]}`);
    if (inputRef.current) inputRef.current.value = '';
    setBusy(false);
    files.reload();
  };

  const act = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg); } catch (e) { toast(errorMessage(e), 'error'); }
    files.reload();
  };
  const remove = (f) => window.confirm(`Delete ${f.name}? This cannot be undone.`) && act(() => api.del(`/files/${f.id}`), 'File deleted');
  const detach = (f) => act(() => api.put(`/files/${f.id}`, { entity_type: null }), 'Detached');

  const menuFor = (f) => [
    { label: 'Preview', onClick: () => setPreview(f) },
    { label: 'Download', onClick: () => downloadFile(f).catch((e) => toast(errorMessage(e), 'error')) },
    can('documents', 'edit') && { label: 'Rename', onClick: () => setRenaming(f) },
    can('documents', 'edit') && { label: 'Move to folder', onClick: () => setMoving(f) },
    can('documents', 'edit') && { label: f.entity_type ? 'Attach to another record' : 'Attach to…', onClick: () => setAttaching(f) },
    can('documents', 'edit') && f.entity_type && { label: 'Detach from record', onClick: () => detach(f) },
    can('documents', 'delete') && { label: 'Delete', danger: true, onClick: () => remove(f), divider: false },
  ].filter(Boolean);

  const columns = [
    {
      key: 'name', label: 'Name',
      render: (f) => (
        <button type="button" className="btn btn-link" style={{ padding: 0, textAlign: 'left' }} onClick={() => setPreview(f)}>
          <span style={{ marginRight: 6 }}>{icon(f.mime)}</span>{f.name}
        </button>
      ),
    },
    { key: 'folder', label: 'Folder', render: (f) => FOLDER_LABEL[f.folder] || f.folder },
    {
      key: 'attached', label: 'Attached to',
      render: (f) => (f.entity_type ? <Badge color="blue">{`${ENTITY_LABEL[f.entity_type] || f.entity_type} #${f.entity_id}`}</Badge> : <span className="muted">—</span>),
    },
    { key: 'size', label: 'Size', align: 'right', render: (f) => fmtSize(f.size) },
    { key: 'created', label: 'Uploaded', render: (f) => (f.created_at ? date(f.created_at.slice(0, 10)) : '') },
    { key: 'actions', label: '', render: (f) => <span onClick={(e) => e.stopPropagation()}><Menu items={menuFor(f)} /></span> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Documents"
        subtitle="Receipts, bills, contracts and other files for your organization"
        actions={(
          <>
            <Tabs tabs={[{ key: 'list', label: 'List' }, { key: 'grid', label: 'Grid' }]} active={view} onChange={setView} />
            {can('documents', 'create') && (
              <>
                <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} />
                <Button variant="primary" loading={busy} onClick={() => inputRef.current?.click()}>Upload to {FOLDER_LABEL[uploadFolder]}</Button>
              </>
            )}
          </>
        )}
      >
        <Input className="search" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
      </PageHeader>

      <div className="mt" style={{ marginTop: 12 }}>
        <Tabs tabs={FOLDERS.map(([key, label]) => ({ key, label }))} active={folder} onChange={setFolder} />
      </div>

      <div
        onDragOver={(e) => { if (!can('documents', 'create')) return; e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (can('documents', 'create')) upload(e.dataTransfer.files); }}
        style={{ marginTop: 12, borderRadius: 8, outline: dragOver ? '2px dashed var(--primary)' : 'none', outlineOffset: 4, minHeight: 200 }}
      >
        {dragOver && <div className="callout" style={{ justifyContent: 'center' }}>Drop files to upload to {FOLDER_LABEL[uploadFolder]}</div>}

        {view === 'list' || !rows.length ? (
          <Table
            columns={columns}
            rows={rows}
            loading={files.loading}
            empty={rows.length === 0 && !files.loading ? (q ? 'No files match your search.' : `No files in ${FOLDER_LABEL[folder]} yet. Drag files here or use Upload.`) : 'No files.'}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            {rows.map((f) => (
              <div key={f.id} className="card" style={{ overflow: 'hidden' }}>
                <button type="button" onClick={() => setPreview(f)} style={{ display: 'block', width: '100%', height: 120, border: 0, background: 'var(--line2)', cursor: 'pointer', padding: 0 }}>
                  {isImage(f.mime) ? <Thumb file={f} /> : <span>{icon(f.mime, 40)}</span>}
                </button>
                <div style={{ padding: '8px 10px' }}>
                  <div className="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</div>
                  <div className="row between" style={{ marginTop: 4 }}>
                    <span className="muted small">{fmtSize(f.size)}</span>
                    <Menu items={menuFor(f)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} onDownload={() => downloadFile(preview).catch((e) => toast(errorMessage(e), 'error'))} />}
      {renaming && <RenameModal file={renaming} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); files.reload(); }} />}
      {moving && <MoveModal file={moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); files.reload(); }} />}
      {attaching && <AttachModal file={attaching} onClose={() => setAttaching(null)} onSaved={() => { setAttaching(null); files.reload(); }} />}
    </div>
  );
}

/** Image thumbnail, loaded through the authenticated download endpoint. */
function Thumb({ file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url;
    let alive = true;
    fetchFileBlob(file.id).then((b) => { if (alive) { url = URL.createObjectURL(b); setSrc(url); } }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [file.id]);
  return src ? <img src={src} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="spin" />;
}

function PreviewModal({ file, onClose, onDownload }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let objectUrl;
    let alive = true;
    fetchFileBlob(file.id)
      .then((b) => { if (alive) { objectUrl = URL.createObjectURL(b); setUrl(objectUrl); } })
      .catch((e) => alive && setErr(errorMessage(e)));
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id]);
  const previewable = isImage(file.mime) || isPdf(file.mime);
  return (
    <Modal
      title={file.name}
      width={900}
      onClose={onClose}
      footer={<><Button onClick={onDownload}>Download</Button><Button variant="primary" onClick={onClose}>Close</Button></>}
    >
      {err && <div className="callout warn">{err}</div>}
      {!err && !url && <div className="center pad"><span className="spin" /></div>}
      {url && previewable && isImage(file.mime) && <img src={url} alt={file.name} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />}
      {url && previewable && isPdf(file.mime) && <iframe title={file.name} src={url} style={{ width: '100%', height: '70vh', border: 0 }} />}
      {url && !previewable && (
        <div className="empty">
          <div className="empty-icon">{icon(file.mime)}</div>
          <p className="muted">No preview for this file type. Download it to open it.</p>
        </div>
      )}
      <div className="muted small" style={{ marginTop: 10 }}>{fmtSize(file.size)} · {file.mime}</div>
    </Modal>
  );
}

function RenameModal({ file, onClose, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast('Enter a name', 'error');
    setBusy(true);
    try { await api.put(`/files/${file.id}`, { name: name.trim() }); toast('Renamed'); onSaved(); } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="Rename file" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <Field label="File name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function MoveModal({ file, onClose, onSaved }) {
  const { toast } = useApp();
  const [folder, setFolder] = useState(file.folder || 'inbox');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.put(`/files/${file.id}`, { folder }); toast(`Moved to ${FOLDER_LABEL[folder]}`); onSaved(); } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="Move to folder" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Move</Button></>}>
      <Field label="Folder"><Select value={folder} onChange={(e) => setFolder(e.target.value)} options={FOLDERS.filter(([k]) => k !== 'all')} /></Field>
    </Modal>
  );
}

/** Attach a file to an invoice, bill, expense or contact. */
function AttachModal({ file, onClose, onSaved }) {
  const { toast, date } = useApp();
  const [type, setType] = useState(file.entity_type && ENTITY_LABEL[file.entity_type] ? file.entity_type : 'invoice');
  const [recordId, setRecordId] = useState(file.entity_type === type && file.entity_id ? String(file.entity_id) : '');
  const docs = useFetch(type === 'invoice' || type === 'bill' ? `/documents/${type}` : null, { per_page: 300, status: 'all' }, [type]);
  const exp = useFetch(type === 'expense' ? '/expenses' : null, null, [type]);
  const contacts = useFetch(type === 'contact' ? '/contacts' : null, { status: 'all', per_page: 500 }, [type]);
  const [busy, setBusy] = useState(false);

  const options = type === 'expense'
    ? (exp.data || []).map((e) => ({ value: e.id, label: e.reference || e.account_name || `Expense #${e.id}`, sub: `${date(e.date)} · ${e.vendor_name || ''} · ${e.total}` }))
    : type === 'contact'
      ? (contacts.data || []).map((c) => ({ value: c.id, label: c.display_name, sub: c.email }))
      : (docs.data?.rows || []).map((d) => ({ value: d.id, label: d.number, sub: `${d.contact_name || ''} · ${date(d.date)}` }));

  const save = async () => {
    if (!recordId) return toast('Choose a record', 'error');
    setBusy(true);
    try { await api.put(`/files/${file.id}`, { entity_type: type, entity_id: Number(recordId) }); toast('Attached'); onSaved(); } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title={`Attach ${file.name}`} onClose={onClose} width={520} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Attach</Button></>}>
      <div className="stack">
        <Field label="Record type">
          <Select value={type} onChange={(e) => { setType(e.target.value); setRecordId(''); }} options={ENTITY} />
        </Field>
        <Field label="Record" required>
          <Combo value={recordId} onChange={(v) => setRecordId(v ? String(v) : '')} options={options} placeholder={`Select ${ENTITY_LABEL[type].toLowerCase()}`} />
        </Field>
      </div>
    </Modal>
  );
}
