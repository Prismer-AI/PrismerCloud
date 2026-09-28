#!/usr/bin/env python3
"""Read-only CLI startup probes. Never opens apps, TCC prompts or account data."""
import argparse
import json
import platform
import shutil
import subprocess


COMMANDS = {'notes': ['memo', 'notes', '--help'],
            'reminders': ['remindctl', 'add', '--help'],
            'imessage': ['imsg', 'send', '--help'],
            'findmy': ['screencapture', '-h']}


def probe(kind, run=subprocess.run):
    result = {'kind': kind, 'os': platform.system(), 'binary': False,
              'startup': False, 'account': 'untested', 'permissions': 'untested',
              'live_operation': 'untested'}
    if result['os'] != 'Darwin':
        return {**result, 'reason': 'macOS execution host required'}
    argv = COMMANDS[kind]
    result['binary'] = bool(shutil.which(argv[0]))
    if not result['binary']:
        return {**result, 'reason': 'missing-command'}
    try:
        response = run(argv, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {**result, 'reason': 'startup-failed'}
    text = response.stdout + response.stderr
    result['startup'] = response.returncode == 0 or (kind == 'findmy' and 'screencapture' in text and '-l' in text)
    result['exit_code'] = response.returncode
    if kind == 'reminders':
        result['alarm_supported'] = '--alarm' in text
    if kind == 'imessage':
        result['send_flags_supported'] = all(flag in text for flag in ('--to', '--file', '--service'))
    result['reason'] = 'help-only-not-ready-for-live-operation' if result['startup'] else 'startup-failed'
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=COMMANDS)
    args = parser.parse_args()
    result = probe(args.kind)
    print(json.dumps(result))
    raise SystemExit(0 if result['startup'] else 1)
