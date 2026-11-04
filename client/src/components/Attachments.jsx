// File helpers shared by the Documents library and entity attachments, plus the compact attachments panel.
import { useRef, useState } from 'react';
import { api, session } from '../api.js';
import { useApp, useFetch } from '../store.jsx';
import { Button, errorMessage } from './ui.jsx';

export const MAX_BYTES = 10 * 1024 * 1024;

/** Fetch a stored file with the auth headers and return it as a Blob (the API never serves files without auth). */
export async function fetchFileBlob(id, { download = false } = {}) {
  const headers = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (session.orgId) headers['x-org-id'] = session.orgId;
  const res = await fetch(`/api/files/${id}/download${download ? '?download=1' : ''}`, { headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return res.blob();
}

/** Save a stored file to disk through a temporary blob URL. */
export async function downloadFile(file) {
  const blob = await fetchFileBlob(file.id, { download: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error(`Could not read ${file.name}`));
  r.readAsDataURL(file);
});

/** Upload several files. `extra` is merged into each request (folder, entity_type, entity_id). */
export async function uploadFiles(fileList, extra = {}) {
  const errors = [];
  let ok = 0;
  for (const file of [...fileList]) {
    if (file.size > MAX_BYTES) { errors.push(`${file.name} is larger than 10 MB`); continue; }
    try {
      const data = await readAsDataUrl(file);
      await api.post('/files', { name: file.name, mime: file.type || 'application/octet-stream', data, ...extra });
      ok += 1;
    } catch (e) {
      errors.push(`${file.name}: ${errorMessage(e)}`);
    }
  }
  return { ok, errors };
}

export function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/**
 * Compact list of files attached to one record. Renders a hint until the record is saved (no entityId).
 */
export default function Attachments({ entityType, entityId }) {
  const { toast } = useApp();
  const files = useFetch(entityId ? '/files' : null, { entity_type: entityType, entity_id: entityId });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  if (!entityId) return <div className="muted small">Save first to attach files.</div>;

  const upload = async (list) => {
    if (!list?.length) return;
    setBusy(true);
    const { ok, errors } = await uploadFiles(list, { entity_type: entityType, entity_id: entityId });
    errors.forEach((m) => toast(m, 'error'));
    if (ok) toast(`${ok} file${ok > 1 ? 's' : ''} attached`);
    if (inputRef.current) inputRef.current.value = '';
    setBusy(false);
    files.reload();
  };

  const download = async (f) => {
    try { await downloadFile(f); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const remove = async (f) => {
    if (!window.confirm(`Delete ${f.name}?`)) return;
    try { await api.del(`/files/${f.id}`); toast('File deleted'); files.reload(); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <div
      className="stack"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
      style={{ outline: over ? '2px dashed var(--primary)' : 'none', outlineOffset: 4, borderRadius: 6 }}
    >
      <div className="row between">
        <span className="muted small">{files.data ? `${files.data.length} attachment${files.data.length === 1 ? '' : 's'}` : ''}</span>
        <div>
          <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} />
          <Button size="sm" loading={busy} onClick={() => inputRef.current?.click()}>+ Upload</Button>
        </div>
      </div>
      {files.loading && !files.data && <span className="spin" />}
      {files.data?.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {files.data.map((f) => (
            <li key={f.id} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--line2)' }}>
              <div style={{ minWidth: 0 }}>
                <button type="button" className="btn btn-link" style={{ padding: 0, textAlign: 'left' }} onClick={() => download(f)}>{f.name}</button>
                <div className="muted small">{fmtSize(f.size)} · {f.created_at?.slice(0, 10)}</div>
              </div>
              <Button size="sm" variant="link" className="btn-danger" onClick={() => remove(f)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      {files.data && !files.data.length && !over && <div className="muted small">Drop receipts here or click Upload. Up to 10 MB per file.</div>}
    </div>
  );
}
