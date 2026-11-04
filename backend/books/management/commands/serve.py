"""Run the OpenBooks API (and the built web app) with waitress, plus the hourly job scheduler.

    python manage.py serve [--port 4000] [--host 0.0.0.0] [--no-jobs] [--threads 8]

With --port 0 a free port is chosen; the line `LISTENING <port>` is printed once ready.
"""
import os
import sys

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Serve the OpenBooks API and web app'

    def add_arguments(self, parser):
        parser.add_argument('--port', type=int, default=int(os.environ.get('PORT') or 4000))
        parser.add_argument('--host', default=os.environ.get('HOST') or '127.0.0.1')
        parser.add_argument('--no-jobs', action='store_true')
        parser.add_argument('--threads', type=int, default=8)

    def handle(self, *args, **opts):
        from django.core.wsgi import get_wsgi_application  # noqa: PLC0415
        from books.core.loader import ensure_loaded  # noqa: PLC0415
        app = get_wsgi_application()
        ensure_loaded()
        if not opts['no_jobs'] and os.environ.get('OPENBOOKS_JOBS', '1') == '1':
            from books.core.jobs import start_scheduler  # noqa: PLC0415
            start_scheduler()
        try:
            from waitress.server import create_server  # noqa: PLC0415
        except ImportError:
            create_server = None
        if create_server:
            server = create_server(app, host=opts['host'], port=opts['port'], threads=opts['threads'], ident='OpenBooks',
                                   max_request_body_size=30 * 1024 * 1024, channel_timeout=120)
            port = server.effective_port
            print(f'LISTENING {port}', flush=True)
            print(f'OpenBooks API listening on http://localhost:{port}', flush=True)
            try:
                server.run()
            except KeyboardInterrupt:
                sys.exit(0)
        else:
            from socketserver import ThreadingMixIn  # noqa: PLC0415
            from wsgiref.simple_server import WSGIServer, make_server  # noqa: PLC0415

            class TServer(ThreadingMixIn, WSGIServer):
                daemon_threads = True
            httpd = make_server(opts['host'], opts['port'], app, server_class=TServer)
            port = httpd.server_port
            print(f'LISTENING {port}', flush=True)
            print(f'OpenBooks API listening on http://localhost:{port} (install waitress for production)', flush=True)
            httpd.serve_forever()
