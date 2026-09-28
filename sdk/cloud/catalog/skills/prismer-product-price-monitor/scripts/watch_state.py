"""Task/tenant bound durable observations and pending-delivery ledger. No network."""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import time


class WatchStore:
    def __init__(self, path, tenant, task):
        if not tenant or not task: raise ValueError('tenant and task are required')
        self.path, self.tenant, self.task = Path(path), tenant, task
        if self.path.is_symlink(): raise ValueError('refusing symlink state')
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600); os.close(fd)
        with self.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS watches (tenant TEXT, task TEXT, name TEXT, state TEXT NOT NULL, PRIMARY KEY(tenant,task,name))')

    @contextlib.contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback(); raise
        finally: db.close()

    def _read(self, db, name):
        row = db.execute('SELECT state FROM watches WHERE tenant=? AND task=? AND name=?', (self.tenant, self.task, name)).fetchone()
        if row is None: raise KeyError(name)
        return json.loads(row[0])

    def _save(self, db, name, state):
        db.execute('UPDATE watches SET state=? WHERE tenant=? AND task=? AND name=?', (json.dumps(state), self.tenant, self.task, name))

    def read(self, name):
        with self.transaction() as db: return self._read(db, name)

    @staticmethod
    def validate(observation, contract):
        for key in ('variant', 'source', 'terms'):
            if key in contract and observation.get(key) != contract[key]:
                raise ValueError(f'{key} mismatch; not the contracted item')
        if observation.get('currency') != contract['currency']:
            raise ValueError('currency mismatch; normalize explicitly before observation')
        total = observation.get('total')
        if isinstance(total, bool) or not isinstance(total, (int, float)) or not math.isfinite(total) or total < 0:
            raise ValueError('finite nonnegative all-in total required')
        if not isinstance(observation.get('available'), bool): raise ValueError('availability required')

    def create(self, name, contract, baseline):
        for key, fallback in (('maximum', -1), ('cooldown', 0)):
            value = contract.get(key, fallback)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('invalid threshold/cooldown')
        self.validate(baseline, contract)
        state = {'contract': contract, 'last_good': baseline, 'pending': None, 'last_alert': None}
        with self.transaction() as db:
            db.execute('INSERT INTO watches VALUES (?,?,?,?)', (self.tenant, self.task, name, json.dumps(state)))

    def observe(self, name, observation, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            state = self._read(db, name)
            if observation is None: return {'status': 'fetch-failed', 'last_good': state['last_good']}
            contract = state['contract']; self.validate(observation, contract)
            state['last_good'] = observation
            fingerprint = hashlib.sha256(json.dumps({k: observation.get(k) for k in ('total', 'currency', 'available', 'variant', 'terms', 'source')}, sort_keys=True).encode()).hexdigest()
            if state['pending']:
                result = {'status': 'pending-existing', **state['pending']}
            elif not observation['available'] or observation['total'] > contract['maximum']:
                result = {'status': 'quiet'}
            elif state['last_alert'] and (state['last_alert']['fingerprint'] == fingerprint or now - state['last_alert']['time'] < contract.get('cooldown', 0)):
                result = {'status': 'quiet'}
            else:
                identity = f'{self.tenant}:{self.task}:{name}:{fingerprint}:{now}'
                pending = {'delivery_id': hashlib.sha256(identity.encode()).hexdigest(), 'fingerprint': fingerprint, 'time': now, 'observation': observation}
                state['pending'] = pending; result = {'status': 'pending', **pending}
            self._save(db, name, state)
            return result

    def ack(self, name, delivery_id, provider_id):
        if not provider_id: raise ValueError('provider-confirmed message ID required')
        with self.transaction() as db:
            state = self._read(db, name)
            if not state['pending'] or state['pending']['delivery_id'] != delivery_id:
                raise ValueError('pending delivery mismatch')
            state['last_alert'] = {**state['pending'], 'provider_id': provider_id}
            state['pending'] = None; self._save(db, name, state)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True); p.add_argument('--tenant', required=True); p.add_argument('--task', required=True)
    p.add_argument('command', choices=['create', 'observe', 'read', 'ack']); p.add_argument('name')
    p.add_argument('--json-file'); p.add_argument('--delivery-id'); p.add_argument('--provider-id')
    args = p.parse_args(); store = WatchStore(args.db, args.tenant, args.task)
    value = None
    if args.json_file:
        with open(args.json_file, encoding='utf-8') as stream: value = json.load(stream)
    if args.command == 'create':
        store.create(args.name, value['contract'], value['baseline']); result = store.read(args.name)
    elif args.command == 'observe': result = store.observe(args.name, value)
    elif args.command == 'ack':
        store.ack(args.name, args.delivery_id, args.provider_id); result = store.read(args.name)
    else: result = store.read(args.name)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
