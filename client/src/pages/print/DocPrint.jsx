// Print/PDF view: opens in a new tab and triggers the browser print dialog ("Save as PDF").
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import DocPaper from '../../components/DocPaper.jsx';
import { Button, Spinner } from '../../components/ui.jsx';

export default function DocPrint() {
  const { type, id } = useParams();
  const { meta, settings } = useApp();
  const { data } = useFetch(`/documents/${type}/${id}`);
  useEffect(() => {
    if (!data) return undefined;
    document.title = `${data.number}`;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [data]);
  if (!data) return <Spinner />;
  return (
    <div className="page" style={{ paddingTop: 16 }}>
      <div className="no-print row mb" style={{ justifyContent: 'center' }}>
        <Button variant="primary" onClick={() => window.print()}>Print / Save as PDF</Button>
        <Button onClick={() => window.close()}>Close</Button>
      </div>
      <DocPaper doc={data} org={meta.org} settings={settings} />
    </div>
  );
}
