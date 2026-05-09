#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import hashlib
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
doc_path = root / "docs/phase_a_protocol_contract.md"
env_go_path = root / "services/shared/proto/envelope.go"
class_go_path = root / "services/shared/proto/message_class.go"
ts_contract_path = root / "server/src/lib/contracts/wsMessage.ts"
schema_path = root / "server/prisma/schema.prisma"

doc = doc_path.read_text(encoding="utf-8")
env_go = env_go_path.read_text(encoding="utf-8")
class_go = class_go_path.read_text(encoding="utf-8")
ts_contract = ts_contract_path.read_text(encoding="utf-8")
schema = schema_path.read_text(encoding="utf-8")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require_section(pattern: str, text: str, label: str) -> str:
    match = re.search(pattern, text, re.S)
    if not match:
        raise SystemExit(f"guard_error=missing_{label}_section")
    return match.group(1)


field_section = require_section(r"### 1\.1 字段约束表(.*?)### 1\.2", doc, "field")
matrix_section = require_section(r"## 3\. 消息类型矩阵 \(Phase A\)(.*?)## 4\.", doc, "matrix")
envelope_struct = require_section(r"type Envelope struct \{(.*?)\n\}", env_go, "envelope_struct")
ts_field_block = require_section(r"export const ENVELOPE_FIELD_NAMES = \[(.*?)\] as const;", ts_contract, "ts_field_block")

contract_fields = re.findall(r'^\|\s*`([a-z0-9_]+)`\s*\|', field_section, re.M)
proto_fields = re.findall(r'`json:"([^",]+)', envelope_struct)
ts_fields = re.findall(r'"([^"]+)"', ts_field_block)

doc_rows = []
for line in matrix_section.splitlines():
    stripped = line.strip()
    if not stripped.startswith("|"):
        continue
    cells = [cell.strip() for cell in stripped.split("|")[1:-1]]
    if len(cells) < 5:
        continue
    if cells[0] == "方向" or set(cells[0]) == {"-"}:
        continue
    doc_rows.append((cells[1].strip("`"), cells[2], cells[3].strip("`")))

contract_types = [row[0] for row in doc_rows]
contract_class_map = {}
for msg_type, message_class, _ in doc_rows:
    normalized = "stream" if "stream" in message_class else "stateful"
    contract_class_map[msg_type] = normalized

stateful_types = set(re.findall(r'"([^"]+)":\s+true', require_section(r"var statefulMessageTypes = map\[string\]bool\{(.*?)\n\}", class_go, "stateful_types")))
stream_types = set(re.findall(r'"([^"]+)":\s+true', require_section(r"var streamMessageTypes = map\[string\]bool\{(.*?)\n\}", class_go, "stream_types")))
go_types = sorted(stateful_types | stream_types)
ts_stateful = set(re.findall(r'"([^"]+)"', require_section(r"export const STATEFUL_MESSAGE_TYPES = \[(.*?)\] as const;", ts_contract, "ts_stateful")))
ts_stream = set(re.findall(r'"([^"]+)"', require_section(r"export const STREAM_MESSAGE_TYPES = \[(.*?)\] as const;", ts_contract, "ts_stream")))
ts_types = sorted(ts_stateful | ts_stream)

errors = []

if sorted(contract_fields) != sorted(proto_fields):
    missing_in_proto = sorted(set(contract_fields) - set(proto_fields))
    missing_in_contract = sorted(set(proto_fields) - set(contract_fields))
    errors.append(
        "field_mismatch contract_only=%s proto_only=%s"
        % (",".join(missing_in_proto) or "-", ",".join(missing_in_contract) or "-")
    )

if sorted(contract_fields) != sorted(ts_fields):
    missing_in_ts = sorted(set(contract_fields) - set(ts_fields))
    missing_in_contract = sorted(set(ts_fields) - set(contract_fields))
    errors.append(
        "field_mismatch_ts contract_only=%s ts_only=%s"
        % (",".join(missing_in_ts) or "-", ",".join(missing_in_contract) or "-")
    )

if sorted(contract_types) != go_types:
    missing_in_go = sorted(set(contract_types) - set(go_types))
    missing_in_contract = sorted(set(go_types) - set(contract_types))
    errors.append(
        "message_type_mismatch contract_only=%s go_only=%s"
        % (",".join(missing_in_go) or "-", ",".join(missing_in_contract) or "-")
    )

if sorted(contract_types) != ts_types:
    missing_in_ts = sorted(set(contract_types) - set(ts_types))
    missing_in_contract = sorted(set(ts_types) - set(contract_types))
    errors.append(
        "message_type_mismatch_ts contract_only=%s ts_only=%s"
        % (",".join(missing_in_ts) or "-", ",".join(missing_in_contract) or "-")
    )

if go_types != ts_types:
    missing_in_ts = sorted(set(go_types) - set(ts_types))
    missing_in_go = sorted(set(ts_types) - set(go_types))
    errors.append(
        "message_type_mismatch_go_ts go_only=%s ts_only=%s"
        % (",".join(missing_in_ts) or "-", ",".join(missing_in_go) or "-")
    )

for msg_type, expected_class in sorted(contract_class_map.items()):
    actual_class = "stream" if msg_type in stream_types else "stateful" if msg_type in stateful_types else "missing"
    if actual_class != expected_class:
        errors.append(f"class_mismatch type={msg_type} contract={expected_class} go={actual_class}")
    ts_class = "stream" if msg_type in ts_stream else "stateful" if msg_type in ts_stateful else "missing"
    if ts_class != expected_class:
        errors.append(f"class_mismatch_ts type={msg_type} contract={expected_class} ts={ts_class}")

phase_a_schema_markers = [
    "model IMRuntime",
    "model IMDaemonSession",
    "model IMSigningKey",
    "assigneeDid",
    "assigneeType",
    "pendingApprovalId",
    "runtimeId",
]
schema_markers_present = [marker for marker in phase_a_schema_markers if marker in schema]
schema_ready = bool(schema_markers_present)

field_hash = sha256_hex("\n".join(sorted(contract_fields)))
proto_hash = sha256_hex("\n".join(sorted(proto_fields)))
ts_field_hash = sha256_hex("\n".join(sorted(ts_fields)))
message_hash = sha256_hex("\n".join(go_types))
ts_message_hash = sha256_hex("\n".join(ts_types))
schema_hash = sha256_hex("\n".join(schema_markers_present)) if schema_ready else "deferred"

print(f"contract_field_hash={field_hash}")
print(f"proto_field_hash={proto_hash}")
print(f"ts_field_hash={ts_field_hash}")
print(f"message_type_hash={message_hash}")
print(f"ts_message_type_hash={ts_message_hash}")
print(f"schema_phase_a_ready={'true' if schema_ready else 'false'}")
print(f"schema_hash={schema_hash}")

if errors:
    print("contract_ok=false")
    for err in errors:
        print(f"guard_error={err}")
    raise SystemExit(1)

print("contract_ok=true")
PY
