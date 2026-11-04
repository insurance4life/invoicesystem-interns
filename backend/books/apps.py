import os
import sys

from django.apps import AppConfig


class BooksConfig(AppConfig):
    name = 'books'
    default_auto_field = 'django.db.models.AutoField'

    def ready(self):
        # `runserver` (dev): start the hourly jobs in the reloader's child process only.
        # The `serve` command starts them itself.
        if 'runserver' in sys.argv and os.environ.get('RUN_MAIN') == 'true' and os.environ.get('OPENBOOKS_JOBS', '1') == '1':
            from books.core.jobs import start_scheduler
            start_scheduler()
