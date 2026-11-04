// Unauthenticated API access for the share, portal and payment-link pages. Deliberately does not use the app store.
import { useCallback, useEffect, useState } from 'react';

export async function publicRequest(method, url, body) {
  const res = await fetch(`/api/public${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Load a public endpoint. Returns {data, error, loading, reload}. */
export function usePublic(url) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return publicRequest('GET', url)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => setState({ data: null, error, loading: false }));
  }, [url]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/** "Line 1, City, State" from an address object saved as JSON. */
export function formatAddress(a) {
  if (!a || typeof a !== 'object') return '';
  return Object.values(a).filter((v) => typeof v === 'string' && v.trim()).join(', ');
}
