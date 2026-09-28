"""Create RFC 5322 drafts from structured JSON, without interpreting MML or sending."""
import argparse
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import make_msgid
import json
import mimetypes
from pathlib import Path


def build(spec):
    if not spec.get('account') or not spec.get('from') or not spec.get('to'):
        raise ValueError('account, from and to are required')
    message = EmailMessage(policy=SMTP)
    for key in ('from', 'to', 'cc', 'bcc', 'subject', 'in-reply-to', 'references'):
        value = spec.get(key)
        if value is not None:
            value = ', '.join(value) if isinstance(value, list) else value
            if '\n' in value or '\r' in value:
                raise ValueError('Header injection rejected')
            message[key] = value
    message['Message-ID'] = make_msgid()
    message.set_content(spec.get('body', ''))
    for item in spec.get('attachments', []):
        if not isinstance(item, dict) or item.get('approved') is not True:
            raise ValueError('Each attachment requires an explicit approved path')
        root = Path(item['root']).resolve(strict=True)
        path = Path(item['path']).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Attachment outside approved root')
        if path.stat().st_size > 25 * 1024 * 1024:
            raise ValueError('Attachment exceeds local 25MiB limit')
        mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        main, sub = mime.split('/', 1)
        message.add_attachment(path.read_bytes(), maintype=main, subtype=sub, filename=path.name)
    return message


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('spec'); p.add_argument('output')
    args = p.parse_args()
    with open(args.spec, encoding='utf-8') as stream: spec = json.load(stream)
    message = build(spec)
    with open(args.output, 'xb') as stream: stream.write(message.as_bytes())
    print(json.dumps({'draft': args.output, 'account': spec['account'], 'message_id': message['Message-ID'], 'sent': False}))


if __name__ == '__main__': main()
