"""Django settings for the OpenBooks API (PostgreSQL)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent          # backend/
PROJECT_DIR = BASE_DIR.parent                              # repo root
DATA_DIR = Path(os.environ.get('DATA_DIR') or BASE_DIR / 'data')
DATA_DIR.mkdir(parents=True, exist_ok=True)
CLIENT_DIST = PROJECT_DIR / 'client' / 'dist'


def _secret():
    if os.environ.get('DJANGO_SECRET_KEY'):
        return os.environ['DJANGO_SECRET_KEY']
    f = DATA_DIR / '.django_secret'
    if not f.exists():
        import secrets
        f.write_text(secrets.token_hex(32))
    return f.read_text()


SECRET_KEY = _secret()
DEBUG = os.environ.get('DJANGO_DEBUG', '0') == '1'
ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', '*').split(',')

INSTALLED_APPS = ['books']
MIDDLEWARE = ['books.security_headers.SecurityHeadersMiddleware']
ROOT_URLCONF = 'openbooks_api.urls'
WSGI_APPLICATION = 'openbooks_api.wsgi.application'
TEMPLATES = []

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ.get('PGDATABASE', 'openbooks'),
        'USER': os.environ.get('PGUSER', 'openbooks'),
        'PASSWORD': os.environ.get('PGPASSWORD', 'openbooks'),
        'HOST': os.environ.get('PGHOST', '127.0.0.1'),
        'PORT': os.environ.get('PGPORT', '5432'),
        'CONN_MAX_AGE': 60,
        'CONN_HEALTH_CHECKS': True,
    }
}

DEFAULT_AUTO_FIELD = 'django.db.models.AutoField'
USE_TZ = True
TIME_ZONE = 'UTC'
USE_I18N = False

# JSON bodies up to 25 MB (file uploads are sent base64 in JSON)
DATA_UPLOAD_MAX_MEMORY_SIZE = 26 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 26 * 1024 * 1024
APPEND_SLASH = False

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'WARNING'},
    'loggers': {
        'openbooks': {'handlers': ['console'], 'level': 'INFO', 'propagate': False},
        'django.request': {'handlers': ['console'], 'level': 'ERROR', 'propagate': False},
    },
}
