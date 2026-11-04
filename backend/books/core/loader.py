"""Loads every feature module (in the same order as the Node app: alphabetical by original file name).

A module (books/modules/<name>.py) may define:
  routes(r)          authenticated, org-scoped routes mounted at /api
  public_routes(r)   unauthenticated routes mounted at /api/public
  job(org, sys_req)  periodic task, run per org at startup and hourly
"""
import importlib
import logging
import threading

from books.core import router

log = logging.getLogger('openbooks')

MODULES = ['accounts', 'assistant', 'automation', 'banking', 'budgets', 'contacts', 'contacts_extra', 'core', 'documents',
           'expenses', 'files', 'fixed_assets', 'fx', 'inventory', 'items', 'payments', 'portal', 'projects', 'reports', 'settings']

JOBS = []
_loaded = False
_lock = threading.Lock()


def ensure_loaded():
    global _loaded  # noqa: PLW0603
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        from books.core import auth_routes  # noqa: PLC0415
        from books.core.db import get  # noqa: PLC0415
        coll = (get('SELECT datcollate FROM pg_database WHERE datname = current_database()') or {}).get('datcollate')
        if coll not in ('C', 'POSIX'):
            log.warning("database collation is %s; create it with LC_COLLATE 'C' for byte-order sorting (see README)", coll)
        auth_routes.routes(router.auth_router)
        auth_routes.internal_routes(router.internal_router)
        for name in MODULES:
            try:
                mod = importlib.import_module(f'books.modules.{name}')
            except ModuleNotFoundError as e:
                if e.name == f'books.modules.{name}':
                    log.warning('module %s is not installed', name)
                    continue
                raise
            if hasattr(mod, 'routes'):
                mod.routes(router.api_router)
            if hasattr(mod, 'public_routes'):
                mod.public_routes(router.public_router)
            if hasattr(mod, 'job'):
                JOBS.append((name, mod.job))
        _loaded = True
