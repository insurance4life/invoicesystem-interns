import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, session } from './api.js';
import { fmtMoney, fmtDate } from './lib/format.js';

const Ctx = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [invites, setInvites] = useState([]);
  const [meta, setMeta] = useState(null);
  const [booting, setBooting] = useState(true);
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, type = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 3500);
  }, []);

  const refreshMeta = useCallback(async () => {
    if (!session.orgId) return null;
    const m = await api.get('/meta');
    setMeta(m);
    return m;
  }, []);

  const boot = useCallback(async () => {
    if (!session.token) { setUser(null); setBooting(false); return; }
    try {
      const me = await api.get('/auth/me');
      setUser(me.user);
      setOrgs(me.orgs);
      setInvites(me.invites || []);
      const ids = me.orgs.map((o) => String(o.id));
      if (!ids.includes(String(session.orgId))) session.orgId = me.user.default_org_id && ids.includes(String(me.user.default_org_id)) ? me.user.default_org_id : me.orgs[0]?.id;
      if (session.orgId) await refreshMeta();
    } catch { setUser(null); }
    setBooting(false);
  }, [refreshMeta]);

  useEffect(() => { boot(); }, [boot]);
  useEffect(() => {
    const out = () => { setUser(null); setMeta(null); };
    window.addEventListener('ob:logout', out);
    return () => window.removeEventListener('ob:logout', out);
  }, []);

  const login = useCallback(async (token) => { session.token = token; setBooting(true); await boot(); }, [boot]);
  const logout = useCallback(() => {
    const tok = session.token;
    // ends the session on the server too, so a copied token stops working (best effort)
    if (tok) fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${tok}` } }).catch(() => {});
    session.token = null; session.orgId = null; setUser(null); setMeta(null); }, []);
  const switchOrg = useCallback(async (id) => { session.orgId = id; setMeta(null); await refreshMeta(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }, [refreshMeta]);

  const value = useMemo(() => {
    const currency = meta?.org?.currency || 'INR';
    const perms = meta?.permissions || {};
    return {
      user, setUser, orgs, setOrgs, invites, meta, refreshMeta, booting, login, logout, switchOrg, toast, reload: boot,
      org: meta?.org, settings: meta?.settings, currency,
      money: (v, cur) => fmtMoney(v, cur || currency),
      date: (d) => fmtDate(d, meta?.org?.date_format),
      can: (module, action = 'view') => { const l = perms['*'] || perms[module] || []; return l.includes(action) || l.includes('*'); },
      account: (id) => meta?.accounts?.find((a) => a.id === Number(id)),
      sysAccount: (code) => meta?.accounts?.find((a) => a.system_code === code),
    };
  }, [user, orgs, invites, meta, refreshMeta, booting, login, logout, switchOrg, toast, boot]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>)}
      </div>
    </Ctx.Provider>
  );
}

export const useApp = () => useContext(Ctx);

/** Load data from the API. Returns {data, loading, error, reload, setData}. */
export function useFetch(url, params, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const key = url ? `${url}?${JSON.stringify(params || {})}` : null;
  const load = useCallback(async () => {
    if (!url) return setState({ data: null, loading: false, error: null });
    setState((s) => ({ ...s, loading: true }));
    try { setState({ data: await api.get(url, params), loading: false, error: null }); }
    catch (e) { setState({ data: null, loading: false, error: e }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}
