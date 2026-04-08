"""
Prismer Daemon — background process for persistent evolution sync.

Provides:
  start_daemon()            — fork a detached daemon process, write PID/port files
  stop_daemon()             — read daemon.pid, send SIGTERM
  daemon_status()           — check if daemon is running, print health info
  append_to_outbox(entry)   — append an outcome entry to the local outbox file (cap 500)
  install_daemon_service()  — install as launchd (macOS) or systemd (Linux) service
  uninstall_daemon_service()— remove the system service
"""

import json
import os
import signal
import shutil
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore

# ============================================================================
# Paths
# ============================================================================

CONFIG_DIR = Path.home() / ".prismer"
CONFIG_PATH = CONFIG_DIR / "config.toml"
PID_PATH = CONFIG_DIR / "daemon.pid"
PORT_PATH = CONFIG_DIR / "daemon.port"
CACHE_DIR = CONFIG_DIR / "cache"
EVOLUTION_CACHE_PATH = CACHE_DIR / "evolution.json"
OUTBOX_PATH = CACHE_DIR / "outbox.json"
EVENTS_FILE = CACHE_DIR / "events.json"

MAX_OUTBOX_SIZE = 500
SYNC_INTERVAL = 60  # seconds
FLUSH_INTERVAL = 30  # seconds
API_TIMEOUT = 10  # seconds
MAX_EVENTS = 1000

# ============================================================================
# Config helpers
# ============================================================================


def _load_config() -> Optional[Dict[str, Any]]:
    if not CONFIG_PATH.exists():
        return None
    try:
        with open(CONFIG_PATH, "rb") as f:
            parsed = tomllib.load(f)
        api_key = parsed.get("default", {}).get("api_key", "")
        base_url = parsed.get("default", {}).get("base_url", "https://prismer.cloud")
        # Also check env vars
        api_key = os.environ.get("PRISMER_API_KEY", api_key)
        base_url = os.environ.get("PRISMER_BASE_URL", base_url)
        if not api_key:
            return None
        return {"api_key": api_key, "base_url": base_url}
    except Exception:
        return None


def _ensure_cache_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================================
# Outbox helpers (usable by external callers without starting daemon)
# ============================================================================


def append_to_outbox(entry: dict) -> None:
    """Append an evolution outcome entry to the local outbox file.

    External callers (hooks, plugins) use this to queue outcomes for the daemon.
    Capped at MAX_OUTBOX_SIZE entries; oldest entries are dropped when full.
    """
    _ensure_cache_dir()
    entries: List[Dict[str, Any]] = []
    if OUTBOX_PATH.exists():
        try:
            entries = json.loads(OUTBOX_PATH.read_text(encoding="utf-8"))
            if not isinstance(entries, list):
                entries = []
        except Exception:
            entries = []
    entries.append({**entry, "_queuedAt": int(time.time() * 1000)})
    # Drop oldest when over cap
    if len(entries) > MAX_OUTBOX_SIZE:
        entries = entries[len(entries) - MAX_OUTBOX_SIZE:]
    _write_secure(OUTBOX_PATH, json.dumps(entries, indent=2))


# ============================================================================
# Event router helpers
# ============================================================================


def _load_events() -> List[Dict[str, Any]]:
    try:
        return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _append_event(event: Dict[str, Any]) -> None:
    events = _load_events()
    events.append(event)
    if len(events) > MAX_EVENTS:
        events = events[len(events) - MAX_EVENTS:]
    _write_secure(EVENTS_FILE, json.dumps(events))


def _emit_sync_event(genes_count: int) -> None:
    if genes_count > 0:
        _append_event({
            "type": "evolution.sync",
            "source": "evolution",
            "priority": "low",
            "title": "Evolution sync complete",
            "body": f"{genes_count} genes updated",
            "timestamp": int(time.time() * 1000),
        })


# ============================================================================
# File helpers
# ============================================================================


def _write_secure(path: Path, content: str) -> None:
    """Write a file with mode 0600."""
    path.write_text(content, encoding="utf-8")
    os.chmod(path, 0o600)


# ============================================================================
# PID helpers
# ============================================================================


def _read_pid() -> Optional[int]:
    if not PID_PATH.exists():
        return None
    try:
        raw = PID_PATH.read_text(encoding="utf-8").strip()
        return int(raw)
    except Exception:
        return None


def _read_port() -> Optional[int]:
    if not PORT_PATH.exists():
        return None
    try:
        raw = PORT_PATH.read_text(encoding="utf-8").strip()
        return int(raw)
    except Exception:
        return None


def _is_process_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _write_pid(pid: int) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _write_secure(PID_PATH, str(pid))


def _write_port(port: int) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _write_secure(PORT_PATH, str(port))


def _cleanup_pid_files() -> None:
    try:
        if PID_PATH.exists():
            PID_PATH.unlink()
    except Exception:
        pass
    try:
        if PORT_PATH.exists():
            PORT_PATH.unlink()
    except Exception:
        pass


# ============================================================================
# HTTP fetch with timeout
# ============================================================================


def _fetch_json(url: str, headers: Dict[str, str], body: Optional[dict] = None) -> Optional[dict]:
    """POST JSON to url, return parsed response or None on error."""
    import httpx

    try:
        with httpx.Client(timeout=API_TIMEOUT) as client:
            resp = client.post(url, headers=headers, json=body or {})
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        pass
    return None


# ============================================================================
# Daemon process (runs in-process when spawned with PRISMER_DAEMON=1)
# ============================================================================


def _run_daemon_process() -> None:
    cfg = _load_config()
    if not cfg:
        sys.stderr.write("[prismer-daemon] No config found. Run 'prismer setup' first.\n")
        sys.exit(1)

    _ensure_cache_dir()

    # State
    state = {
        "last_sync": 0,
        "sync_count": 0,
        "evolution_cursor": 0,
        "start_time": time.time(),
        "running": True,
    }

    # Load persisted cursor from cache
    if EVOLUTION_CACHE_PATH.exists():
        try:
            cached = json.loads(EVOLUTION_CACHE_PATH.read_text(encoding="utf-8"))
            if isinstance(cached.get("cursor"), (int, float)):
                state["evolution_cursor"] = int(cached["cursor"])
        except Exception:
            pass

    # ── Health HTTP server on random port ──

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/health":
                outbox_size = 0
                if OUTBOX_PATH.exists():
                    try:
                        entries = json.loads(OUTBOX_PATH.read_text(encoding="utf-8"))
                        if isinstance(entries, list):
                            outbox_size = len(entries)
                    except Exception:
                        pass
                body = json.dumps({
                    "pid": os.getpid(),
                    "uptime": int(time.time() - state["start_time"]),
                    "lastSync": state["last_sync"],
                    "syncCount": state["sync_count"],
                    "outboxSize": outbox_size,
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/events":
                events = _load_events()
                body = json.dumps(events[-50:]).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")

        def log_message(self, format: str, *args: Any) -> None:
            # Suppress default access logging
            pass

    server = HTTPServer(("127.0.0.1", 0), HealthHandler)
    port = server.server_address[1]
    _write_pid(os.getpid())
    _write_port(port)
    sys.stdout.write(f"[prismer-daemon] Started. PID={os.getpid()} port={port}\n")
    sys.stdout.flush()

    # Run HTTP server in a daemon thread
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    api_key = cfg["api_key"]
    base_url = cfg["base_url"]
    sync_url = f"{base_url}/api/im/evolution/sync"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    # ── Evolution sync ──
    def do_evolution_sync() -> None:
        try:
            data = _fetch_json(sync_url, headers, {
                "pull": {"since": state["evolution_cursor"], "scope": "global"},
            })
            if data is not None:
                state["last_sync"] = int(time.time() * 1000)
                state["sync_count"] += 1
                # Advance cursor if server returns one
                cursor_val = None
                if isinstance(data.get("data"), dict) and isinstance(data["data"].get("cursor"), (int, float)):
                    cursor_val = int(data["data"]["cursor"])
                elif isinstance(data.get("cursor"), (int, float)):
                    cursor_val = int(data["cursor"])
                if cursor_val is not None:
                    state["evolution_cursor"] = cursor_val
                _ensure_cache_dir()
                pulled = data.get("data") or data
                _write_secure(
                    EVOLUTION_CACHE_PATH,
                    json.dumps({
                        "cursor": state["evolution_cursor"],
                        "lastSync": state["last_sync"],
                        "data": pulled,
                    }, indent=2),
                )
                genes = pulled.get("genes") if isinstance(pulled, dict) else None
                _emit_sync_event(len(genes) if isinstance(genes, list) else 0)
        except Exception:
            # Non-fatal — retry on next tick
            pass

    # ── Outbox flush ──
    def do_outbox_flush() -> None:
        if not OUTBOX_PATH.exists():
            return
        entries: List[Dict[str, Any]] = []
        try:
            entries = json.loads(OUTBOX_PATH.read_text(encoding="utf-8"))
            if not isinstance(entries, list) or len(entries) == 0:
                return
        except Exception:
            return

        try:
            data = _fetch_json(sync_url, headers, {
                "push": {"outcomes": entries},
                "pull": {"since": 0},
            })
            if data is not None:
                # Clear outbox on success
                _write_secure(OUTBOX_PATH, "[]")
        except Exception:
            # Non-fatal — entries remain in outbox for next flush
            pass

    # ── Recurring loop threads ──
    def sync_loop() -> None:
        while state["running"]:
            time.sleep(SYNC_INTERVAL)
            if not state["running"]:
                break
            do_evolution_sync()

    def flush_loop() -> None:
        while state["running"]:
            time.sleep(FLUSH_INTERVAL)
            if not state["running"]:
                break
            do_outbox_flush()

    sync_thread = threading.Thread(target=sync_loop, daemon=True)
    flush_thread = threading.Thread(target=flush_loop, daemon=True)
    sync_thread.start()
    flush_thread.start()

    # ── Graceful shutdown ──
    def shutdown(signum: int, frame: Any) -> None:
        sys.stdout.write("[prismer-daemon] Shutting down.\n")
        sys.stdout.flush()
        state["running"] = False
        _cleanup_pid_files()
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Initial syncs
    do_evolution_sync()
    do_outbox_flush()

    # Block main thread waiting for signal
    try:
        while state["running"]:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        shutdown(signal.SIGINT, None)


# ============================================================================
# Public API: start_daemon / stop_daemon / daemon_status
# ============================================================================


def start_daemon() -> None:
    """Start the daemon as a detached background process.
    Prevents duplicates by checking existing PID.
    """
    existing_pid = _read_pid()
    if existing_pid is not None and _is_process_running(existing_pid):
        port = _read_port()
        port_str = f" port={port}" if port else ""
        print(f"Daemon already running. PID={existing_pid}{port_str}")
        return

    # Stale PID file — clean up
    _cleanup_pid_files()

    # Check config before spawning
    cfg = _load_config()
    if not cfg:
        print("No API key found. Run 'prismer setup' first.", file=sys.stderr)
        sys.exit(1)

    # If we're already inside the daemon process, just run inline
    if os.environ.get("PRISMER_DAEMON") == "1":
        _run_daemon_process()
        return

    # Spawn a detached child process
    env = {**os.environ, "PRISMER_DAEMON": "1"}
    subprocess.Popen(
        [sys.executable, "-m", "prismer.daemon"],
        env=env,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )

    # Wait briefly for PID file to appear
    waited = 0
    while waited < 3000:
        time.sleep(0.1)
        waited += 100
        pid = _read_pid()
        port = _read_port()
        if pid is not None and port is not None:
            print(f"Daemon started. PID={pid} port={port}")
            return

    print("Daemon spawned (PID file not yet written — may take a moment).")


def stop_daemon() -> None:
    """Stop the running daemon by sending SIGTERM."""
    pid = _read_pid()
    if pid is None or not _is_process_running(pid):
        print("Daemon: not running")
        _cleanup_pid_files()
        return
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Daemon stopped (PID={pid})")
        _cleanup_pid_files()
    except OSError as e:
        print(f"Failed to stop daemon: {e}", file=sys.stderr)


def daemon_status() -> None:
    """Print daemon status. If running, query the health endpoint."""
    pid = _read_pid()
    if pid is None or not _is_process_running(pid):
        print("Daemon: not running")
        _cleanup_pid_files()
        return

    port = _read_port()
    if not port:
        print(f"Daemon: running (PID={pid}, port unknown)")
        return

    # Query health endpoint
    import httpx

    try:
        with httpx.Client(timeout=3) as client:
            resp = client.get(f"http://127.0.0.1:{port}/health")
            if resp.status_code == 200:
                health = resp.json()
                last_sync_str = "never"
                if health.get("lastSync"):
                    from datetime import datetime, timezone
                    last_sync_str = datetime.fromtimestamp(
                        health["lastSync"] / 1000, tz=timezone.utc
                    ).isoformat()
                print("Daemon: running")
                print(f"  PID:        {health['pid']}")
                print(f"  Uptime:     {health['uptime']}s")
                print(f"  Last sync:  {last_sync_str}")
                print(f"  Sync count: {health['syncCount']}")
                print(f"  Outbox:     {health['outboxSize']} entries")
                print(f"  Port:       {port}")
                return
    except Exception:
        pass
    print(f"Daemon: running (PID={pid} port={port}, health check failed)")


# ============================================================================
# Service registration: launchd (macOS) / systemd (Linux)
# ============================================================================


def _resolve_prismer_cmd() -> str:
    """Find the prismer CLI executable path."""
    which = shutil.which("prismer")
    if which:
        return which
    return f"{sys.executable} -m prismer"


def _install_launchd() -> None:
    plist_dir = Path.home() / "Library" / "LaunchAgents"
    plist_path = plist_dir / "cloud.prismer.daemon.plist"
    prismer_cmd = _resolve_prismer_cmd()
    python_path = sys.executable
    bin_dir = str(Path(python_path).parent)
    log_dir = Path.home() / ".prismer"

    # Build ProgramArguments array entries
    if " -m " in prismer_cmd:
        # sys.executable -m prismer
        prog_args = f"""\
    <string>{python_path}</string>
    <string>-m</string>
    <string>prismer</string>
    <string>daemon</string>
    <string>start</string>"""
    else:
        prog_args = f"""\
    <string>{prismer_cmd}</string>
    <string>daemon</string>
    <string>start</string>"""

    plist = f"""\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.prismer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    {prog_args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRISMER_DAEMON</key>
    <string>1</string>
    <key>PATH</key>
    <string>{bin_dir}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log_dir / "daemon.stdout.log"}</string>
  <key>StandardErrorPath</key>
  <string>{log_dir / "daemon.stderr.log"}</string>
</dict>
</plist>"""

    plist_dir.mkdir(parents=True, exist_ok=True)
    plist_path.write_text(plist, encoding="utf-8")
    os.chmod(plist_path, 0o600)

    try:
        subprocess.run(["launchctl", "load", str(plist_path)], capture_output=True, check=True)
        print("[prismer] Daemon service installed and started (launchd)")
        print(f"  Plist: {plist_path}")
    except Exception:
        print(f"[prismer] Plist written. Load manually: launchctl load {plist_path}")


def _uninstall_launchd() -> None:
    plist_path = Path.home() / "Library" / "LaunchAgents" / "cloud.prismer.daemon.plist"
    try:
        subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    except Exception:
        pass
    try:
        plist_path.unlink()
    except Exception:
        pass
    print("[prismer] Daemon service uninstalled (launchd)")


def _install_systemd() -> None:
    service_dir = Path.home() / ".config" / "systemd" / "user"
    service_path = service_dir / "prismer-daemon.service"
    prismer_cmd = _resolve_prismer_cmd()
    python_path = sys.executable
    bin_dir = str(Path(python_path).parent)

    # Build ExecStart
    if " -m " in prismer_cmd:
        exec_start = f"{python_path} -m prismer daemon start"
    else:
        exec_start = f"{prismer_cmd} daemon start"

    unit = f"""\
[Unit]
Description=Prismer Daemon — background evolution sync
After=network-online.target

[Service]
Type=simple
Environment=PRISMER_DAEMON=1
Environment=PATH={bin_dir}:/usr/local/bin:/usr/bin:/bin
ExecStart={exec_start}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"""

    service_dir.mkdir(parents=True, exist_ok=True)
    service_path.write_text(unit, encoding="utf-8")
    os.chmod(service_path, 0o644)

    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, check=True)
        subprocess.run(["systemctl", "--user", "enable", "prismer-daemon"], capture_output=True, check=True)
        subprocess.run(["systemctl", "--user", "start", "prismer-daemon"], capture_output=True, check=True)
        print("[prismer] Daemon service installed and started (systemd)")
        print(f"  Service: {service_path}")
    except Exception:
        print("[prismer] Service file written. Enable manually:")
        print("  systemctl --user enable --now prismer-daemon")


def _uninstall_systemd() -> None:
    try:
        subprocess.run(["systemctl", "--user", "stop", "prismer-daemon"], capture_output=True)
    except Exception:
        pass
    try:
        subprocess.run(["systemctl", "--user", "disable", "prismer-daemon"], capture_output=True)
    except Exception:
        pass
    service_path = Path.home() / ".config" / "systemd" / "user" / "prismer-daemon.service"
    try:
        service_path.unlink()
    except Exception:
        pass
    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    except Exception:
        pass
    print("[prismer] Daemon service uninstalled (systemd)")


def install_daemon_service() -> None:
    """Install the daemon as a persistent system service (launchd on macOS, systemd on Linux)."""
    platform = sys.platform

    if platform == "darwin":
        _install_launchd()
    elif platform == "linux":
        _install_systemd()
    else:
        print(f"Daemon auto-start not supported on {platform}. Use: prismer daemon start")


def uninstall_daemon_service() -> None:
    """Uninstall the daemon system service."""
    platform = sys.platform

    if platform == "darwin":
        _uninstall_launchd()
    elif platform == "linux":
        _uninstall_systemd()
    else:
        print(f"No daemon service to uninstall on {platform}.")


# ============================================================================
# Entry point: called when spawned with PRISMER_DAEMON=1 or via python -m
# ============================================================================

if os.environ.get("PRISMER_DAEMON") == "1":
    _run_daemon_process()
