"""
Python SDK Integration Test — written from README documentation.
Tests a real agent developer workflow against local IM server.

Usage: cd sdk/python && python3 -m pytest ../tests/test_python_sdk.py -v
   Or: cd /path/to/project && python3 sdk/tests/test_python_sdk.py
"""

import sys, os, time, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

BASE = 'http://localhost:3200'
PASS = '\033[32m✓\033[0m'
FAIL = '\033[31m✗\033[0m'

passed = 0
failed = 0
failures = []


def check(condition, msg, detail=''):
    global passed, failed
    if condition:
        print(f'  {PASS} {msg}')
        passed += 1
    else:
        full = f'{msg} — {detail}' if detail else msg
        print(f'  {FAIL} {full}')
        failed += 1
        failures.append(full)


def main():
    global passed, failed
    print('═══ Python SDK Integration Test ═══')
    print(f'Target: {BASE}\n')

    # --- Import SDK based on README ---
    from prismer import PrismerClient
    from prismer.signal_rules import extract_signals
    from prismer.encryption import E2EEncryption

    # --- Phase 1: Registration (README "Quick Start") ---
    print('── Phase 1: Registration ──')

    # README: PrismerClient(base_url=...) — no api_key for anonymous registration
    client = PrismerClient(base_url=BASE)
    ts = str(int(time.time() * 1000))

    # README: client.im.account.register(type='agent', ...)
    # NOTE: Server expects camelCase (displayName, agentType).
    # Python SDK passes **kwargs directly — no snake_case conversion.
    r = client.im.account.register(
        type='agent',
        username=f'py-test-{ts}',
        displayName='Python Test Agent',
        agentType='assistant',
        capabilities=['chat', 'analysis'],
    )
    # NOTE: Python SDK _request() returns raw dict, not IMResult object.
    # This is a doc/code divergence — README says IMResult but actual is dict.
    check(r.get('ok') == True, 'Register agent')
    check(r.get('data', {}).get('token') is not None, 'Returns token')
    check(r.get('data', {}).get('isNew') == True, 'isNew=true on first register')

    token1 = r.get("data")['token']
    user_id1 = r.get("data")['imUserId']

    # README: client.set_token(token)
    client.set_token(token1)

    # Second agent
    client2 = PrismerClient(base_url=BASE)
    r2 = client2.im.account.register(
        type='agent',
        username=f'py-test-b-{ts}',
        displayName='Python Test Agent B',
    )
    check(r2.get("ok"), 'Register second agent')
    token2 = r2.get("data")['token']
    user_id2 = r2.get("data")['imUserId']
    client2.set_token(token2)

    # README: client.im.account.me()
    me = client.im.account.me()
    check(me.get("ok"), 'GET /me')
    check(me.get("data").get('user', {}).get('username') == f'py-test-{ts}', '/me correct username')

    # --- Phase 2: Discovery ---
    print('\n── Phase 2: Discovery ──')
    agents = client.im.contacts.discover()
    check(agents.get("ok"), 'Discover agents')
    check(isinstance(agents.get("data"), list), 'Returns list')

    # --- Phase 3: Messaging ---
    print('\n── Phase 3: Messaging ──')
    m = client.im.direct.send(user_id2, 'Hello from Python!')
    check(m.get('ok'), 'Send DM')
    check('message' in (m.get('data') or {}), 'DM returns message')
    conv_id = (m.get('data') or {}).get('conversationId')

    m2 = client.im.direct.send(user_id2, '**Bold**', type='markdown')
    check(m2.get('ok'), 'Send markdown DM')

    history = client.im.direct.get_messages(user_id2, limit=10)
    check(history.get('ok'), 'Get DM history')
    check(isinstance(history.get('data'), list), 'History is list')

    # --- Phase 4: Groups ---
    print('\n── Phase 4: Groups ──')
    g = client.im.groups.create(title=f'PyGroup-{ts}', members=[user_id2])
    check(g.get('ok'), 'Create group')
    group_id = (g.get('data') or {}).get('groupId')

    if group_id:
        gm = client.im.groups.send(group_id, 'Hello group from Python!')
        check(gm.get('ok'), 'Send group message')

    # --- Phase 5: Conversations ---
    print('\n── Phase 5: Conversations ──')
    convos = client.im.conversations.list()
    check(convos.get('ok'), 'List conversations')
    check(isinstance(convos.get('data'), list), 'Returns list')

    contacts = client.im.contacts.list()
    check(contacts.get('ok'), 'List contacts')

    # --- Phase 6: Credits ---
    print('\n── Phase 6: Credits ──')
    credits = client.im.credits.get()
    check(credits.get('ok'), 'Get credits')
    check('balance' in (credits.get('data') or {}), 'Has balance')

    txns = client.im.credits.transactions(limit=5)
    check(txns.get('ok'), 'Get transactions')

    # --- Phase 7: Memory ---
    print('\n── Phase 7: Memory ──')
    mf = client.im.memory.create_file('TEST_MEMORY.md', '# Python Test\n\n- Item 1')
    check(mf.get('ok'), 'Create memory file')

    files = client.im.memory.list_files()
    check(files.get('ok'), 'List memory files')

    load = client.im.memory.load()
    check(load.get('ok'), 'Load auto-memory')

    # --- Phase 8: Tasks ---
    print('\n── Phase 8: Tasks ──')
    task = client.im.tasks.create(title='Python SDK test task', capability='analysis')
    check(task.get('ok'), 'Create task')
    task_id = (task.get('data') or {}).get('id')

    tasks = client.im.tasks.list()
    check(tasks.get('ok'), 'List tasks')

    if task_id:
        claim = client2.im.tasks.claim(task_id)
        check(claim.get('ok'), 'Claim task')

    # --- Phase 9: Evolution ---
    print('\n── Phase 9: Evolution ──')
    stats = client.im.evolution.get_stats()
    check(stats.get('ok'), 'Public stats')

    gene = client.im.evolution.create_gene(
        category='repair',
        signals_match=[{'type': 'error:timeout'}],
        strategy=['Increase timeout', 'Add retry'],
        title='Python Timeout Fix',
    )
    check(gene.get('ok'), 'Create gene')
    gene_id = (gene.get('data') or {}).get('id')

    genes = client.im.evolution.list_genes()
    check(genes.get('ok'), 'List genes')

    analyze = client.im.evolution.analyze(
        signals=[{'type': 'error:timeout'}],
        error='timeout exceeded',
    )
    check(analyze.get('ok'), 'Analyze signals')

    if gene_id:
        record = client.im.evolution.record(
            gene_id=gene_id,
            signals=[{'type': 'error:timeout'}],
            outcome='success',
            summary='Applied timeout increase from Python SDK',
        )
        check(record.get('ok'), 'Record outcome')

    # --- Phase 10: Signal Rules (local, no server) ---
    print('\n── Phase 10: Signal Rules ──')
    s1 = extract_signals(error='Connection timed out')
    check(len(s1) > 0, 'extract_signals returns results')
    check(s1[0]['type'] == 'error:timeout', f'Detects timeout (got {s1[0]["type"]})')

    s2 = extract_signals(error='ECONNREFUSED', provider='postgres', stage='connect')
    check(s2[0]['type'] == 'error:connection_refused', 'Detects connection_refused')
    check(s2[0].get('provider') == 'postgres', 'Preserves provider')
    check(s2[0].get('stage') == 'connect', 'Preserves stage')

    s3 = extract_signals(error='panic: segfault', severity='critical')
    check(s3[0]['type'] == 'error:crash', 'Detects crash')

    s4 = extract_signals(task_status='failed', tags=['deploy'])
    check(any(s['type'] == 'task.failed' for s in s4), 'Detects task.failed')

    # --- Phase 11: E2E Encryption (local, no server) ---
    print('\n── Phase 11: E2E Encryption ──')
    enc = E2EEncryption()
    enc.init('test-passphrase')
    check(enc.is_initialized, 'Encryption initialized')

    pub_key = enc.export_public_key()
    check(pub_key is not None and len(pub_key) > 10, 'Public key exported')

    enc.generate_session_key('conv1')
    check(enc.has_session_key('conv1'), 'Session key generated')

    ct = enc.encrypt('conv1', 'hello from python')
    pt = enc.decrypt('conv1', ct)
    check(pt == 'hello from python', f'Encrypt/decrypt roundtrip (got: {pt})')

    # --- Phase 12: Evolution Outbox (local) ---
    print('\n── Phase 12: Evolution Outbox ──')
    from prismer.evolution_outbox import EvolutionOutbox

    call_log = []
    def mock_request(method, path, **kwargs):
        call_log.append((method, path))

    outbox = EvolutionOutbox(mock_request, flush_interval=0.1)
    op_id = outbox.enqueue('record', {'gene_id': 'test', 'signals': [], 'outcome': 'success', 'summary': 'test'})
    check(op_id.startswith('evo_'), f'Outbox returns op ID (got {op_id[:10]}...)')
    check(outbox.pending_count == 1, 'Pending count = 1')

    flushed = outbox.flush()
    check(flushed == 1, f'Flush sends 1 op (got {flushed})')
    check(len(call_log) == 1, 'Mock request called')
    check(call_log[0][1] == '/api/im/evolution/record', f'Correct endpoint (got {call_log[0][1]})')

    # --- Summary ---
    print(f'\n═══ Summary ═══')
    print(f'  Passed:  {passed}')
    print(f'  Failed:  {failed}')
    if failures:
        print('\n  Failures:')
        for f in failures:
            print(f'    {FAIL} {f}')
    print()
    sys.exit(1 if failed > 0 else 0)


if __name__ == '__main__':
    main()
