"""Periodic jobs (recurring documents, reminders, depreciation, bank cleanup...) run per org, hourly."""
import logging
import threading
import time

from django.db import connection

from books.core.db import all, get

log = logging.getLogger('openbooks')


class SysReq:
    """A stand-in for an HTTP request when jobs act on behalf of the organization's admin."""

    def __init__(self, org, user):
        self.org = org
        self.user = user
        self.perms = {'*': ['view', 'create', 'edit', 'delete', 'approve']}
        self.role = 'Admin'
        self.body = {}
        self.query = {}
        self.params = {}
        self.headers = {}


def run_jobs():
    from books.core.loader import ensure_loaded, JOBS  # noqa: PLC0415
    from books.core.router import API_LOCK  # noqa: PLC0415
    ensure_loaded()
    # The lock is taken per org and job, not for the whole pass, so one tenant's backlog cannot stall every request.
    with API_LOCK:
        org_ids = [o['id'] for o in all('SELECT id FROM orgs ORDER BY id')]
    for org_id in org_ids:
        for name, fn in JOBS:
            with API_LOCK:
                org = get('SELECT * FROM orgs WHERE id = ?', org_id)
                if not org:
                    break
                admin = get('''SELECT u.id, u.name, u.email FROM org_users ou JOIN users u ON u.id = ou.user_id
                               JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? AND r.name = 'Admin' AND ou.status = 'active'
                               ORDER BY ou.id LIMIT 1''', org_id)
                sys_req = SysReq(org, admin or {'id': None, 'name': 'System'})
                try:
                    fn(org, sys_req)
                except Exception as e:  # noqa: BLE001
                    log.error('job %s failed for org %s: %s', name, org_id, e)


def _loop(interval):
    while True:
        try:
            run_jobs()
        except Exception as e:  # noqa: BLE001
            log.error('jobs failed: %s', e)
        finally:
            connection.close()
        time.sleep(interval)


_started = False


def start_scheduler(interval=3600):
    global _started  # noqa: PLW0603
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, args=(interval,), daemon=True, name='openbooks-jobs').start()
