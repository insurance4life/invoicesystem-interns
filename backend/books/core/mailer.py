"""Outbox + optional SMTP delivery (port of mailer.js). Configure SMTP_HOST etc. to send for real."""
import datetime
import html
import os
import re
import smtplib
import ssl
import threading
from email.message import EmailMessage
from email.utils import formataddr

from books.core.db import get, insert, update
from books.core.router import bad, CURRENT_USER_ID


def _send_smtp(email_id, frm, reply_to, to, cc, subject, body):
    from books.core.router import API_LOCK  # noqa: PLC0415
    try:
        msg = EmailMessage()
        msg['From'] = frm
        if reply_to:
            msg['Reply-To'] = reply_to
        msg['To'] = to
        if cc:
            msg['Cc'] = cc
        msg['Subject'] = subject
        msg.set_content(body)
        msg.add_alternative(html.escape(body).replace('\n', '<br>'), subtype='html')
        port = int(os.environ.get('SMTP_PORT') or 587)
        secure = os.environ.get('SMTP_SECURE') == 'true'
        ctx = ssl.create_default_context()  # verify the relay's certificate and host name
        with (smtplib.SMTP_SSL(os.environ['SMTP_HOST'], port, timeout=20, context=ctx) if secure
              else smtplib.SMTP(os.environ['SMTP_HOST'], port, timeout=20)) as s:
            if not secure:
                s.ehlo()
                if s.has_extn('starttls'):
                    s.starttls(context=ctx)
                    s.ehlo()
                elif os.environ.get('SMTP_ALLOW_INSECURE') != 'true':
                    # never send credentials or mail in clear text unless the operator opted in (e.g. a local relay)
                    raise smtplib.SMTPException('The SMTP server does not offer STARTTLS; set SMTP_SECURE=true or SMTP_ALLOW_INSECURE=true')
            if os.environ.get('SMTP_USER'):
                s.login(os.environ['SMTP_USER'], os.environ.get('SMTP_PASS', ''))
            s.send_message(msg)
        status, err = 'sent', None
    except Exception as e:  # noqa: BLE001
        status, err = 'failed', str(e)
    from django.db import connection  # noqa: PLC0415
    with API_LOCK:
        update('emails', email_id, {'status': status, 'error': err})
    connection.close()


def _recipients(*fields):
    return [a for f in fields for a in re.split(r'[,;]', str(f or '')) if a.strip()]


def check_send_quota(org, to, cc=None):
    """Raise 400 when sending would exceed a limit. The hourly cap is counted per organization and also per sending
    user, because anyone can create more organizations; recipients per message are capped so one send cannot fan out."""
    max_rcpt = int(os.environ.get('OPENBOOKS_EMAIL_MAX_RECIPIENTS') or 10)
    if len(_recipients(to, cc)) > max_rcpt:
        raise bad(f'An email can have at most {max_rcpt} recipients')
    limit = int(os.environ.get('OPENBOOKS_EMAIL_HOURLY_LIMIT') or 100)
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S')
    if get('SELECT COUNT(*) AS n FROM emails WHERE org_id = ? AND created_at >= ?', org['id'], since)['n'] >= limit:
        raise bad(f'This organization has sent {limit} emails in the last hour. Try again later.')
    uid = CURRENT_USER_ID.get()
    if uid and get('SELECT COUNT(*) AS n FROM emails WHERE sent_by = ? AND created_at >= ?', uid, since)['n'] >= limit:
        raise bad(f'You have sent {limit} emails in the last hour. Try again later.')


def send_email(org, to, subject, body, entity_type=None, entity_id=None, cc=None, stored_body=None):
    """Store an email in the outbox and send it via SMTP when configured.
    stored_body replaces body in the outbox copy (used to keep credentials out of the stored record)."""
    check_send_quota(org, to, cc)
    email_id = insert('emails', {'org_id': org['id'], 'to_addr': to, 'cc': cc or None, 'subject': subject,
                                 'body': body if stored_body is None else stored_body,
                                 'entity_type': entity_type, 'entity_id': entity_id, 'status': 'queued',
                                 'sent_by': CURRENT_USER_ID.get()})
    if not os.environ.get('SMTP_HOST'):
        update('emails', email_id, {'status': 'logged'})
        return email_id
    # The sender is always the operator's address; the org only appears as the display name and Reply-To, so a
    # tenant cannot make the operator's relay send mail "from" an address it merely typed into its profile.
    sender = os.environ.get('SMTP_FROM') or os.environ.get('SMTP_USER')
    if not sender:
        update('emails', email_id, {'status': 'failed', 'error': 'Set SMTP_FROM or SMTP_USER to send email'})
        return email_id
    frm = formataddr((org.get('name') or '', sender))
    threading.Thread(target=_send_smtp, args=(email_id, frm, org.get('email'), to, cc, subject, body), daemon=True).start()
    return email_id


def fill_template(tpl, vars):  # noqa: A002
    """Fill {placeholders} in a template (unknown or null placeholders are left as is)."""
    from books.core.jsutil import jsstr  # noqa: PLC0415

    def rep(m):
        v = vars.get(m.group(1))
        return m.group(0) if v is None else (jsstr(v) if not isinstance(v, str) else v)
    return re.sub(r'\{(\w+)\}', rep, str(tpl or ''))


DEFAULT_TEMPLATES = {
    'invoice': {'subject': 'Invoice {number} from {org_name}', 'body': 'Dear {contact_name},\n\nThank you for your business. Your invoice {number} for {currency} {total} is due on {due_date}.\n\nView and pay online: {link}\n\nRegards,\n{org_name}'},
    'quote': {'subject': 'Quote {number} from {org_name}', 'body': 'Dear {contact_name},\n\nPlease find our quote {number} for {currency} {total}. It is valid until {due_date}.\n\nView, accept or decline: {link}\n\nRegards,\n{org_name}'},
    'salesorder': {'subject': 'Sales Order {number} from {org_name}', 'body': 'Dear {contact_name},\n\nYour sales order {number} for {currency} {total} has been confirmed.\n\n{link}\n\nRegards,\n{org_name}'},
    'creditnote': {'subject': 'Credit Note {number} from {org_name}', 'body': 'Dear {contact_name},\n\nA credit note {number} for {currency} {total} has been issued to you.\n\n{link}\n\nRegards,\n{org_name}'},
    'retainer': {'subject': 'Retainer Invoice {number} from {org_name}', 'body': 'Dear {contact_name},\n\nPlease pay the retainer {number} for {currency} {total}.\n\n{link}\n\nRegards,\n{org_name}'},
    'purchaseorder': {'subject': 'Purchase Order {number} from {org_name}', 'body': 'Dear {contact_name},\n\nPlease find our purchase order {number} for {currency} {total}.\n\n{link}\n\nRegards,\n{org_name}'},
    'payment_received': {'subject': 'Payment received – {number}', 'body': 'Dear {contact_name},\n\nWe have received your payment of {currency} {amount}. Thank you!\n\nRegards,\n{org_name}'},
    'payment_made': {'subject': 'Payment advice – {number}', 'body': 'Dear {contact_name},\n\nWe have made a payment of {currency} {amount} to you.\n\nRegards,\n{org_name}'},
    'reminder': {'subject': 'Payment reminder: invoice {number} is {days_overdue} days overdue', 'body': 'Dear {contact_name},\n\nThis is a friendly reminder that invoice {number} for {currency} {balance} was due on {due_date}.\n\nPay online: {link}\n\nRegards,\n{org_name}'},
    'statement': {'subject': 'Account statement from {org_name}', 'body': 'Dear {contact_name},\n\nPlease find your account statement attached. Your outstanding balance is {currency} {balance}.\n\nRegards,\n{org_name}'},
}
