#!/usr/bin/env python3
"""Task-bound competitor watch checkpoint; no scheduler or network side effects."""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime
from urllib.parse import urlsplit


def initial(workspace, task, sources):
    if not workspace or not task or not sources or any(not isinstance(s, str) or not s for s in sources):
        raise ValueError("workspace, task and source IDs are required")
    return {"version": 1, "workspace": workspace, "task": task, "revision": 0,
            "sources": {source: {"cursor": None, "error": None} for source in sources}, "events": {}}


def check_identity(state, workspace, task):
    if state.get("version") != 1 or (state.get("workspace"), state.get("task")) != (workspace, task):
        raise ValueError("checkpoint belongs to another workspace/task or schema")


def collect(state, results, events):
    state = copy.deepcopy(state)
    successful = set()
    seen = set()
    for result in results:
        source = result["source"]
        if source in seen:
            raise ValueError("duplicate source result; aggregate all pages before collecting")
        seen.add(source)
        if source not in state["sources"]:
            raise ValueError("unknown source: " + source)
        previous = state["sources"][source]
        if result.get("ok") is True:
            cursor = result["cursor"]
            instant = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
            if instant.tzinfo is None:
                raise ValueError("cursor requires timezone")
            if previous["cursor"] and instant < datetime.fromisoformat(previous["cursor"].replace("Z", "+00:00")):
                raise ValueError("source cursor cannot move backwards")
            previous.update(cursor=cursor, error=None)
            successful.add(source)
        else:
            previous["error"] = str(result.get("error") or "unknown coverage")
    for event in events:
        event_id = event.get("id")
        if not isinstance(event_id, str) or not event_id or not event.get("summary"):
            raise ValueError("event requires stable underlying-event ID and summary")
        if event_id in state["events"]:
            continue
        if event.get("source") not in successful:
            raise ValueError("new event requires a successful source result")
        url = urlsplit(event.get("url", ""))
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError("event requires an evidence URL without credentials")
        state["events"][event_id] = {**event, "delivery": "new", "receipt": None}
    return state


def prepare(state, ids):
    state = copy.deepcopy(state)
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("unique event IDs required")
    for event_id in ids:
        event = state["events"][event_id]
        if event["delivery"] != "new":
            raise ValueError("already pending/delivered; reconcile receipt before retry")
        event["delivery"] = "pending"
    return state


def ack(state, ids, receipt):
    state = copy.deepcopy(state)
    if not isinstance(receipt, str) or not receipt.strip() or not ids:
        raise ValueError("actual delivery receipt and event IDs required")
    for event_id in ids:
        event = state["events"][event_id]
        if event["delivery"] == "delivered" and event["receipt"] == receipt:
            continue
        if event["delivery"] != "pending":
            raise ValueError("event is not pending this delivery")
        event.update(delivery="delivered", receipt=receipt)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--expected-revision", type=int)
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init")
    init.add_argument("--source", action="append", required=True)
    sub.add_parser("show")
    tick = sub.add_parser("collect")
    tick.add_argument("--input", type=Path, required=True)
    sending = sub.add_parser("prepare")
    sending.add_argument("ids", nargs="+")
    sent = sub.add_parser("ack")
    sent.add_argument("ids", nargs="+")
    sent.add_argument("--receipt", required=True)
    args = parser.parse_args()
    path = args.state
    if not path.is_absolute():
        parser.error("--state must be an absolute task-specific path")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(path.suffix + ".lock")
    fd = None
    temporary = None
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        if args.action == "init":
            if path.exists():
                raise ValueError("state already exists; restore/read it instead of resetting")
            state = initial(args.workspace, args.task, args.source)
        else:
            state = json.loads(path.read_text(encoding="utf-8"))
            check_identity(state, args.workspace, args.task)
            if args.action != "show" and args.expected_revision != state["revision"]:
                raise ValueError("expected-revision missing or stale; reload latest task checkpoint")
            if args.action == "collect":
                data = json.loads(args.input.read_text(encoding="utf-8"))
                state = collect(state, data["sources"], data.get("events", []))
            elif args.action == "prepare":
                state = prepare(state, args.ids)
            elif args.action == "ack":
                state = ack(state, args.ids, args.receipt)
        if args.action != "show":
            state["revision"] += 1
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(state, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"watch checkpoint failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
        if fd is not None:
            try:
                own = os.fstat(fd)
                current = lock.stat(follow_symlinks=False)
                if (own.st_dev, own.st_ino) == (current.st_dev, current.st_ino):
                    lock.unlink()
            finally:
                os.close(fd)


if __name__ == "__main__":
    sys.exit(main())
