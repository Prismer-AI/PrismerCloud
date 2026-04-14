"""Prismer Cloud SDK CLI — modular CLI for Prismer Cloud SDK.

Top-level shortcuts: send, load, search, parse, recall, discover
Top-level group:     skill (find/install/list/show/uninstall/sync)
Grouped namespaces:  im, context, evolve, community, task, memory, file, workspace, security, identity
Utilities:           init, register, status, config, token
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import click

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore

import tomli_w


# ============================================================================
# Config helpers
# ============================================================================

CONFIG_DIR = Path.home() / ".prismer"
CONFIG_FILE = CONFIG_DIR / "config.toml"


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def _load_config() -> Dict[str, Any]:
    if not CONFIG_FILE.exists():
        return {}
    with open(CONFIG_FILE, "rb") as f:
        return tomllib.load(f)


def _save_config(cfg: Dict[str, Any]) -> None:
    _ensure_config_dir()
    with open(CONFIG_FILE, "wb") as f:
        tomli_w.dump(cfg, f)


def _get_api_key(cfg: Optional[Dict[str, Any]] = None) -> Optional[str]:
    if cfg is None:
        cfg = _load_config()
    return cfg.get("default", {}).get("api_key")


def _set_nested(cfg: Dict[str, Any], dotted_key: str, value: str) -> None:
    parts = dotted_key.split(".")
    d = cfg
    for part in parts[:-1]:
        d = d.setdefault(part, {})
    d[parts[-1]] = value


def _mask_key(key: str) -> str:
    if not key:
        return "(not set)"
    if len(key) <= 16:
        return key[:4] + "..." + key[-4:]
    return key[:11] + "..." + key[-4:]


def _get_im_client():
    from .client import PrismerClient
    cfg = _load_config()
    token = cfg.get("auth", {}).get("im_token", "")
    if not token:
        from .cli_ui import error as _err
        _err("No IM token. Run 'prismer register' first.")
        sys.exit(1)
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "")
    return PrismerClient(token, environment=env, base_url=base_url)


def _get_api_client():
    from .client import PrismerClient
    cfg = _load_config()
    api_key = cfg.get("default", {}).get("api_key", "")
    if not api_key:
        from .cli_ui import error as _err
        _err("No API key. Run 'prismer init <api-key>' first.")
        sys.exit(1)
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "")
    return PrismerClient(api_key, environment=env, base_url=base_url)


def _parse_signals(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    raw = raw.strip()
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(s) for s in parsed]
        except Exception:
            pass
    return [s.strip() for s in raw.split(",") if s.strip()]


# ============================================================================
# CLI root group
# ============================================================================

@click.group()
def cli():
    """Prismer Cloud SDK CLI"""
    pass


# ============================================================================
# Utility commands: init, register, status
# ============================================================================

@cli.command()
@click.argument("api_key", required=False, default=None)
@click.option('--browser', is_flag=True, help='Open browser for authentication (link to existing account)')
def init(api_key, browser):
    """Initialize Prismer. With key: store and verify. Without: auto-register with free credits."""
    import time as _time
    cfg = _load_config()
    cfg.setdefault("default", {})

    if browser:
        # ── Path C: Browser OAuth / setup flow ──
        import http.server
        import secrets
        import socket
        import threading
        import urllib.parse
        import webbrowser

        base_url = cfg["default"].get("base_url", "") or "https://prismer.cloud"
        state = secrets.token_urlsafe(32)
        received = {}
        server_holder = {}

        # Find a free port
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]

        class _CallbackHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                params = urllib.parse.parse_qs(parsed.query)
                recv_state = (params.get("state") or [""])[0]
                recv_key = (params.get("key") or [""])[0]
                if recv_state != state:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"State mismatch. Please retry.")
                    return
                received["key"] = recv_key
                body = (
                    b"<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
                    b"<h2>Prismer connected!</h2>"
                    b"<p>You can close this tab and return to the terminal.</p>"
                    b"</body></html>"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                # Signal the main thread after response is flushed
                threading.Thread(target=server_holder["srv"].shutdown, daemon=True).start()

            def log_message(self, format, *args):
                pass  # suppress request logs

        httpd = http.server.HTTPServer(("127.0.0.1", port), _CallbackHandler)
        server_holder["srv"] = httpd

        callback_url = f"http://127.0.0.1:{port}/callback"
        auth_url = (
            f"{base_url}/setup"
            f"?callback={urllib.parse.quote(callback_url, safe='')}"
            f"&state={state}"
            f"&utm_source=python-sdk"
        )

        from .cli_ui import info, Spinner as _Spinner
        info("Opening browser for Prismer authentication...")
        click.echo(f"  URL: {auth_url}")
        info("Waiting for callback (timeout: 5 minutes)...")

        webbrowser.open(auth_url)

        # Serve with a 5-minute timeout using a daemon thread
        def _serve():
            httpd.serve_forever()

        t = threading.Thread(target=_serve, daemon=True)
        t.start()
        t.join(timeout=300)

        api_key_received = received.get("key", "")
        if not api_key_received:
            from .cli_ui import error as _err
            _err("Authentication timed out or no key received.")
            click.echo(f"Get your key at: {base_url}/dashboard")
            raise SystemExit(1)

        cfg["default"]["api_key"] = api_key_received
        cfg["default"].setdefault("base_url", "https://prismer.cloud")
        _save_config(cfg)
        from .cli_ui import success as _succ
        _succ(f"API key saved to {CONFIG_FILE}")
        info("You can now use all Prismer CLI, plugin, and MCP features.")
        return

    if api_key:
        # ── Path B: Human provides API key ──
        from .cli_ui import success as _succ, error as _err, warn as _warn, info as _info, Spinner as _Spinner
        if not api_key.startswith("sk-prismer-"):
            _err("Invalid key format. API keys start with sk-prismer-")
            click.echo("Get your key at: https://prismer.cloud/dashboard")
            raise SystemExit(1)

        base_url = cfg["default"].get("base_url", "") or "https://prismer.cloud"
        try:
            import httpx
            with _Spinner("Verifying API key..."):
                r = httpx.get(f"{base_url}/api/version", headers={"Authorization": f"Bearer {api_key}"}, timeout=5)
            if r.status_code == 401:
                _err("API key is invalid or expired.")
                click.echo("Get a new key at: https://prismer.cloud/dashboard")
                raise SystemExit(1)
            _succ("API key verified.")
        except ImportError:
            _warn("Could not verify key (httpx not installed). Saving anyway.")
        except SystemExit:
            raise
        except Exception as e:
            _warn(f"Could not verify key ({e}). Saving anyway.")

        cfg["default"]["api_key"] = api_key
        cfg["default"].setdefault("environment", "production")
        _save_config(cfg)
        _succ(f"Saved to {CONFIG_FILE}")
        _info("You can now use all Prismer CLI, plugin, and MCP features.")
    else:
        # ── Path A: Auto-register with free agent credits ──
        from .cli_ui import success as _succ, error as _err, info as _info, key_value as _kv, Spinner as _Spinner
        existing_key = cfg["default"].get("api_key", "")
        if existing_key.startswith("sk-prismer-"):
            _info(f"Already configured ({existing_key[:20]}...)")
            return
        if cfg.get("auth", {}).get("im_token"):
            _info("Already registered as agent (IM token exists).")
            click.echo("For more credits, get API key: https://prismer.cloud/dashboard")
            return

        base_url = cfg["default"].get("base_url", "") or "https://prismer.cloud"
        username = f"py-cli-{int(_time.time())}"
        try:
            import httpx
            with _Spinner("Registering with free agent credits..."):
                r = httpx.post(f"{base_url}/api/im/register", json={
                    "username": username, "displayName": username, "type": "agent"
                }, timeout=10)
                data = r.json()
            if not data.get("ok"):
                raise Exception(data.get("error", {}).get("message", "Registration failed"))

            cfg.setdefault("auth", {})
            cfg["auth"]["im_token"] = data["data"].get("token", "")
            cfg["auth"]["im_user_id"] = data["data"].get("imUserId") or data["data"].get("userId", "")
            cfg["auth"]["im_username"] = data["data"].get("username", username)
            _save_config(cfg)
            _succ("Registered with free agent credits.")
            _kv({
                "Username": cfg["auth"]["im_username"],
                "User ID": cfg["auth"]["im_user_id"],
            })
            click.echo("")
            _info("For more credits, get API key: https://prismer.cloud/dashboard")
        except ImportError:
            _err("httpx not installed. Run: pip install prismer")
            raise SystemExit(1)
        except Exception as e:
            _err(f"Auto-registration failed: {e}")
            click.echo("Get API key manually: https://prismer.cloud/dashboard")
            raise SystemExit(1)


@cli.command()
@click.argument("username")
@click.option("--type", "user_type", type=click.Choice(["agent", "human"]), default="agent",
              help="Identity type (default: agent)")
@click.option("--display-name", default=None, help="Display name (defaults to username)")
@click.option("--agent-type",
              type=click.Choice(["assistant", "specialist", "orchestrator", "tool", "bot"]),
              default=None, help="Agent type")
@click.option("--capabilities", default=None, help="Comma-separated capabilities")
@click.option("--endpoint", default=None, help="Webhook endpoint URL")
@click.option("--webhook-secret", default=None, help="Webhook HMAC secret")
def register(username: str, user_type: str, display_name: Optional[str],
             agent_type: Optional[str], capabilities: Optional[str],
             endpoint: Optional[str], webhook_secret: Optional[str]):
    """Register an IM identity and store the token."""
    cfg = _load_config()
    api_key = _get_api_key(cfg)
    if not api_key:
        click.echo("No API key. Run 'prismer init <api-key>' first.", err=True)
        sys.exit(1)

    kwargs: Dict[str, Any] = {
        "type": user_type,
        "username": username,
        "displayName": display_name or username,
    }
    if agent_type:
        kwargs["agentType"] = agent_type
    if capabilities:
        kwargs["capabilities"] = [c.strip() for c in capabilities.split(",")]
    if endpoint:
        kwargs["endpoint"] = endpoint
    if webhook_secret:
        kwargs["webhookSecret"] = webhook_secret

    from .client import PrismerClient
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "") or None
    client = PrismerClient(api_key, environment=env, base_url=base_url)
    try:
        result = client.im.account.register(**kwargs)
    finally:
        client.close()

    from .cli_ui import success as _succ, error as _err, key_value as _kv

    if not result.get("ok"):
        err = result.get("error", {})
        msg = err.get("message", "Unknown error") if isinstance(err, dict) else str(err)
        _err(f"Registration failed: {msg}")
        sys.exit(1)

    data = result.get("data", {})
    cfg.setdefault("auth", {})
    cfg["auth"]["im_token"] = data.get("token", "")
    cfg["auth"]["im_user_id"] = data.get("imUserId", "")
    cfg["auth"]["im_username"] = data.get("username", username)
    cfg["auth"]["im_token_expires"] = data.get("expiresIn", "")
    _save_config(cfg)

    _succ("Registration successful!")
    _kv({
        "User ID": data.get("imUserId", "N/A"),
        "Username": data.get("username", username),
        "Display": data.get("displayName", username),
        "Role": data.get("role", "N/A"),
        "New": str(data.get("isNew", False)),
    })
    _succ(f"Token stored in {CONFIG_FILE}")


@cli.command()
def status():
    """Show current config and token status."""
    from .cli_ui import info as _info, warn as _warn, error as _err, success as _succ, key_value as _kv, print_panel, Spinner as _Spinner
    cfg = _load_config()
    if not cfg:
        _warn("No config found. Run 'prismer init <api-key>' first.")
        return

    default = cfg.get("default", {})
    print_panel(
        f"api_key     = {_mask_key(default.get('api_key', ''))}\n"
        f"environment = {default.get('environment', 'production')}\n"
        f"base_url    = {default.get('base_url', '') or '(default)'}",
        title="default",
        border_style="cyan",
    )

    auth = cfg.get("auth", {})
    if auth:
        token = auth.get("im_token", "")
        token_display = f"{token[:20]}..." if token else "(not set)"
        status_line = ""
        expires_str = auth.get("im_token_expires", "")
        if expires_str:
            try:
                exp = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                if exp < now:
                    status_line = "[red]EXPIRED[/red]"
                else:
                    delta = exp - now
                    hours = delta.total_seconds() / 3600
                    if hours < 1:
                        status_line = f"[green]valid[/green] ({int(delta.total_seconds() / 60)}m remaining)"
                    elif hours < 24:
                        status_line = f"[green]valid[/green] ({hours:.1f}h remaining)"
                    else:
                        status_line = f"[green]valid[/green] ({delta.days}d remaining)"
            except (ValueError, TypeError):
                status_line = f"set (expires in {expires_str})"

        auth_content = (
            f"im_user_id  = {auth.get('im_user_id', '')}\n"
            f"im_username = {auth.get('im_username', '')}\n"
            f"im_token    = {token_display}"
        )
        if status_line:
            auth_content += f"\nstatus      = {status_line}"
        print_panel(auth_content, title="auth", border_style="green")
    else:
        _warn("Not registered — run 'prismer register <username>'")

    im_token = auth.get("im_token", "") if auth else ""
    if im_token:
        click.echo("")
        try:
            from .client import PrismerClient
            env = default.get("environment", "production")
            base_url = default.get("base_url", "") or None
            client = PrismerClient(im_token, environment=env, base_url=base_url)
            with _Spinner("Fetching live status..."):
                try:
                    me_result = client.im.account.me()
                finally:
                    client.close()
            if me_result.get("ok"):
                me_data = me_result.get("data", {})
                user = me_data.get("user", {})
                credits_info = me_data.get("credits", {})
                stats = me_data.get("stats", {})
                _kv({
                    "Display": user.get("displayName", "N/A"),
                    "Role": user.get("role", "N/A"),
                    "Credits": str(credits_info.get("balance", "N/A")),
                    "Messages": str(stats.get("messagesSent", "N/A")),
                    "Unread": str(stats.get("unreadCount", "N/A")),
                })
            else:
                err = me_result.get("error", {})
                msg = err.get("message", "Unknown error") if isinstance(err, dict) else str(err)
                _warn(f"Could not fetch live status: {msg}")
        except Exception as e:
            _warn(f"Could not fetch live status: {e}")


# ============================================================================
# config group
# ============================================================================

@cli.group()
def config():
    """Manage configuration."""
    pass


@config.command("show")
def config_show():
    """Print config file contents."""
    if not CONFIG_FILE.exists():
        click.echo(f"No config file found at {CONFIG_FILE}")
        return
    with open(CONFIG_FILE, "r") as f:
        click.echo(f.read())


@config.command("set")
@click.argument("key")
@click.argument("value")
def config_set(key: str, value: str):
    """Set a config value (e.g. default.base_url)."""
    cfg = _load_config()
    _set_nested(cfg, key, value)
    _save_config(cfg)
    click.echo(f"Set {key} = {value}")


# ============================================================================
# token group
# ============================================================================

@cli.group()
def token():
    """Token management."""
    pass


@token.command("refresh")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def token_refresh(as_json: bool):
    """Refresh IM JWT token."""
    cfg = _load_config()
    im_token = cfg.get("auth", {}).get("im_token", "")
    if not im_token:
        click.echo("No IM token. Run 'prismer register' first.", err=True)
        sys.exit(1)
    im_user_id = cfg.get("auth", {}).get("im_user_id", "")
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "")
    from .client import PrismerClient
    client = PrismerClient(im_token, environment=env, base_url=base_url)
    try:
        res = client.im.account.refresh_token(user_id=im_user_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            err = res.get("error", {})
            err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            if "not found" in err_msg.lower():
                click.echo("User not found. Your registration may have expired. Run 'prismer register <username>' to re-register.", err=True)
            else:
                click.echo(f"Error: {err_msg}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        if data and data.get("token"):
            cfg = _load_config()
            cfg.setdefault("auth", {})
            cfg["auth"]["im_token"] = data["token"]
            if data.get("expiresIn"):
                cfg["auth"]["im_token_expires"] = data["expiresIn"]
            _save_config(cfg)
            click.echo("Token refreshed and saved.")
        else:
            click.echo("Token refreshed (no new token in response).")
    finally:
        client.close()


# ============================================================================
# im group
# ============================================================================

@cli.group()
def im():
    """IM messaging, groups, conversations, and credits."""
    pass


@im.command("send")
@click.argument("user_id")
@click.argument("message")
@click.option("-t", "--type", "msg_type", default="text", help="Message type: text, markdown, code, etc.")
@click.option("--reply-to", default=None, help="Reply to a message ID (parentId)")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_send(user_id, message, msg_type, reply_to, as_json):
    """Send a direct message to a user."""
    client = _get_im_client()
    try:
        opts: Dict[str, Any] = {}
        if msg_type and msg_type != "text":
            opts["type"] = msg_type
        if reply_to:
            opts["parent_id"] = reply_to
        res = client.im.direct.send(user_id, message, **opts)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Message sent (conversationId: {res.get('data', {}).get('conversationId')})")
    finally:
        client.close()


@im.command("messages")
@click.argument("user_id")
@click.option("-n", "--limit", default=20, help="Max messages")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_messages(user_id, limit, as_json):
    """View direct message history with a user."""
    client = _get_im_client()
    try:
        res = client.im.direct.get_messages(user_id, limit=limit)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        msgs = res.get("data", [])
        if as_json:
            click.echo(json.dumps(msgs, indent=2))
            return
        if not msgs:
            click.echo("No messages.")
            return
        for m in msgs:
            ts = m.get("createdAt", "")
            sender = m.get("sender", {}).get("username") or m.get("senderId", "?")
            click.echo(f"[{ts}] {sender}: {m.get('content', '')}")
    finally:
        client.close()


@im.command("edit")
@click.argument("conversation_id")
@click.argument("message_id")
@click.argument("content")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_edit(conversation_id, message_id, content, as_json):
    """Edit an existing message."""
    client = _get_im_client()
    try:
        res = client.im.messages.edit(conversation_id, message_id, content)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Message {message_id} updated.")
    finally:
        client.close()


@im.command("delete")
@click.argument("conversation_id")
@click.argument("message_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_delete(conversation_id, message_id, as_json):
    """Delete a message."""
    client = _get_im_client()
    try:
        res = client.im.messages.delete(conversation_id, message_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Message {message_id} deleted.")
    finally:
        client.close()


@im.command("discover")
@click.option("--type", "agent_type", default=None, help="Filter by agent type")
@click.option("--capability", default=None, help="Filter by capability")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_discover(agent_type, capability, as_json):
    """Discover available agents."""
    client = _get_im_client()
    try:
        kwargs: Dict[str, str] = {}
        if agent_type:
            kwargs["type"] = agent_type
        if capability:
            kwargs["capability"] = capability
        res = client.im.contacts.discover(**kwargs)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        agents = res.get("data", [])
        if as_json:
            click.echo(json.dumps(agents, indent=2))
            return
        if not agents:
            click.echo("No agents found.")
            return
        click.echo(f"{'Username':<20}{'Type':<14}{'Status':<10}Display Name")
        for a in agents:
            click.echo(f"{a.get('username', ''):<20}{a.get('agentType', a.get('role', '')):<14}{a.get('status', ''):<10}{a.get('displayName', '')}")
    finally:
        client.close()


@im.command("contacts")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_contacts(as_json):
    """List contacts."""
    client = _get_im_client()
    try:
        res = client.im.contacts.list()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        contacts = res.get("data", [])
        if as_json:
            click.echo(json.dumps(contacts, indent=2))
            return
        if not contacts:
            click.echo("No contacts.")
            return
        click.echo(f"{'Username':<20}{'Role':<10}{'Unread':<8}Display Name")
        for c in contacts:
            click.echo(f"{c.get('username', ''):<20}{c.get('role', ''):<10}{c.get('unreadCount', 0):<8}{c.get('displayName', '')}")
    finally:
        client.close()


@im.command("conversations")
@click.option("--unread", is_flag=True, help="Show unread only")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_conversations(unread, as_json):
    """List conversations."""
    client = _get_im_client()
    try:
        kwargs: Dict[str, Any] = {}
        if unread:
            kwargs["with_unread"] = True
            kwargs["unread_only"] = True
        res = client.im.conversations.list(**kwargs)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        convos = res.get("data", [])
        if as_json:
            click.echo(json.dumps(convos, indent=2))
            return
        if not convos:
            click.echo("No conversations.")
            return
        for c in convos:
            cid = c.get("id") or c.get("conversationId") or ""
            unread_str = f" ({c.get('unreadCount', 0)} unread)" if c.get("unreadCount") else ""
            click.echo(f"{cid}  {c.get('type', '')}  {c.get('title') or c.get('participantName', '')}{unread_str}")
    finally:
        client.close()


@im.command("read")
@click.argument("conversation_id")
def im_read(conversation_id):
    """Mark a conversation as read."""
    client = _get_im_client()
    try:
        res = client.im.conversations.mark_as_read(conversation_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo("Marked as read.")
    finally:
        client.close()


@im.command("heartbeat")
@click.option("--status", "hb_status", default="online", help="Presence status: online, busy, offline")
@click.option("--load", "load_val", default=None, type=float, help="Load factor 0.0-1.0")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_heartbeat(hb_status, load_val, as_json):
    """Send agent heartbeat (online/busy/offline)."""
    client = _get_im_client()
    try:
        body: Dict[str, Any] = {"status": hb_status}
        if load_val is not None:
            body["load"] = load_val
        res = client.im._request("POST", "/api/im/agents/heartbeat", json=body)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        load_str = f", load: {load_val}" if load_val is not None else ""
        click.echo(f"Heartbeat sent (status: {hb_status}{load_str}).")
    finally:
        client.close()


@im.command("me")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_me(as_json):
    """Show current identity and stats."""
    client = _get_im_client()
    try:
        res = client.im.account.me()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        d = res.get("data", {})
        if as_json:
            click.echo(json.dumps(d, indent=2))
            return
        user = d.get("user", {})
        card = d.get("agentCard", {})
        stats = d.get("stats", {})
        credits_info = d.get("credits", {})
        click.echo(f"Display Name: {user.get('displayName', '-')}")
        click.echo(f"Username:     {user.get('username', '-')}")
        click.echo(f"Role:         {user.get('role', '-')}")
        click.echo(f"Agent Type:   {card.get('agentType', '-')}")
        click.echo(f"Credits:      {credits_info.get('balance', stats.get('credits', '-'))}")
        click.echo(f"Messages:     {stats.get('messagesSent', stats.get('totalMessages', '-'))}")
        click.echo(f"Unread:       {stats.get('unreadCount', '-')}")
    finally:
        client.close()


@im.command("credits")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_credits(as_json):
    """Show credits balance."""
    client = _get_im_client()
    try:
        res = client.im.credits.get()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Balance: {res.get('data', {}).get('balance', '-')}")
    finally:
        client.close()


@im.command("transactions")
@click.option("-n", "--limit", default=20, help="Max transactions")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_transactions(limit, as_json):
    """Show credit transaction history."""
    client = _get_im_client()
    try:
        res = client.im.credits.transactions(limit=limit)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        txns = res.get("data", [])
        if as_json:
            click.echo(json.dumps(txns, indent=2))
            return
        if not txns:
            click.echo("No transactions.")
            return
        click.echo(f"{'Date':<24}{'Type':<20}{'Amount':<12}Description")
        for t in txns:
            click.echo(f"{t.get('createdAt', ''):<24}{t.get('type', ''):<20}{str(t.get('amount', '')):<12}{t.get('description', '')}")
    finally:
        client.close()


@im.command("health")
def im_health():
    """Check IM service health."""
    client = _get_im_client()
    try:
        res = client.im.health()
        click.echo(f"IM Service: {'OK' if res.get('ok') else 'ERROR'}")
        if not res.get("ok"):
            click.echo(res.get("error"), err=True)
            sys.exit(1)
    finally:
        client.close()


# --- im groups sub-group ---

@im.group("groups")
def im_groups():
    """Group chat management."""
    pass


@im_groups.command("create")
@click.argument("title")
@click.option("-m", "--members", default="", help="Comma-separated member IDs")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_create(title, members, as_json):
    """Create a new group."""
    client = _get_im_client()
    try:
        member_list = [m.strip() for m in members.split(",") if m.strip()] if members else []
        res = client.im.groups.create(title, member_list)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Group created (groupId: {res.get('data', {}).get('groupId')})")
    finally:
        client.close()


@im_groups.command("list")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_list(as_json):
    """List groups you belong to."""
    client = _get_im_client()
    try:
        res = client.im.groups.list()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        groups = res.get("data", [])
        if as_json:
            click.echo(json.dumps(groups, indent=2))
            return
        if not groups:
            click.echo("No groups.")
            return
        for g in groups:
            gid = g.get("groupId") or g.get("id") or ""
            members = g.get("members", [])
            click.echo(f"{gid}  {g.get('title', '')} ({len(members) if members else '?'} members)")
    finally:
        client.close()


@im_groups.command("send")
@click.argument("group_id")
@click.argument("message")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_send(group_id, message, as_json):
    """Send a message to a group."""
    client = _get_im_client()
    try:
        res = client.im.groups.send(group_id, message)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo("Message sent to group.")
    finally:
        client.close()


@im_groups.command("messages")
@click.argument("group_id")
@click.option("-n", "--limit", default=20, help="Max messages")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_messages(group_id, limit, as_json):
    """View group message history."""
    client = _get_im_client()
    try:
        res = client.im.groups.get_messages(group_id, limit=limit)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        msgs = res.get("data", [])
        if as_json:
            click.echo(json.dumps(msgs, indent=2))
            return
        if not msgs:
            click.echo("No messages.")
            return
        for m in msgs:
            ts = m.get("createdAt", "")
            sender = m.get("sender", {}).get("username") or m.get("senderId", "?")
            click.echo(f"[{ts}] {sender}: {m.get('content', '')}")
    finally:
        client.close()


# ============================================================================
# context group
# ============================================================================

@cli.group("context")
def context():
    """Context loading, searching, and caching."""
    pass


@context.command("load")
@click.argument("urls", nargs=-1, required=True)
@click.option("-f", "--format", "fmt", default="hqcc", help="Return format: hqcc, raw, both")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_load(urls, fmt, as_json):
    """Load one or more URLs into context."""
    client = _get_api_client()
    try:
        input_val = urls[0] if len(urls) == 1 else list(urls)
        return_config = {"format": fmt}
        res = client.load(input_val, return_config=return_config)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Load failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        results = res.results or (res.result and [res.result]) or []
        for r in results:
            click.echo(f"\n--- {r.url or 'result'} ---")
            if r.hqcc:
                click.echo(r.hqcc[:2000] + ("... [truncated]" if len(r.hqcc) > 2000 else ""))
            if r.cached is not None:
                click.echo(f"[cached: {r.cached}]")
        if not results and res.result:
            r = res.result
            click.echo(f"URL:     {r.url}")
            click.echo(f"Status:  {'cached' if r.cached else 'loaded'}")
            if r.hqcc:
                click.echo(f"\n--- HQCC ---\n{r.hqcc[:2000]}")
    finally:
        client.close()


@context.command("search")
@click.argument("query")
@click.option("-k", "--top-k", default=5, help="Number of results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_search(query, top_k, as_json):
    """Search for content using a natural language query."""
    client = _get_api_client()
    try:
        res = client.search(query, top_k=top_k)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Search failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        results = res.results or []
        if not results:
            click.echo("No results.")
            return
        click.echo(f'Search results for: "{query}"\n')
        for i, r in enumerate(results, 1):
            score = r.ranking.score if r.ranking else "-"
            click.echo(f"{i}. {r.url}  score: {score}")
            if r.hqcc:
                click.echo(f"   {r.hqcc[:200]}")
            click.echo("")
    finally:
        client.close()


@context.command("save")
@click.argument("url")
@click.argument("hqcc")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_save(url, hqcc, as_json):
    """Save a URL and its HQCC content to the context cache."""
    client = _get_api_client()
    try:
        res = client.save(url=url, hqcc=hqcc)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Save failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        click.echo(f"Saved: {url}")
    finally:
        client.close()


# ============================================================================
# parse group
# ============================================================================

@cli.group("parse")
def parse_cmd():
    """Document parsing commands."""
    pass


@parse_cmd.command("run")
@click.argument("url")
@click.option("-m", "--mode", default="fast", help="Parse mode: fast, hires, auto")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def parse_run(url, mode, as_json):
    """Parse a document via OCR."""
    client = _get_api_client()
    try:
        res = client.parse_pdf(url, mode=mode)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Parse failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        if res.task_id:
            click.echo(f"Task ID: {res.task_id}")
            click.echo(f"Status:  {res.status or 'processing'}")
            click.echo(f"\nCheck: prismer parse status {res.task_id}")
        elif res.document:
            click.echo("Status: complete")
            content = res.document.markdown or res.document.text or ""
            click.echo(content[:5000])
    finally:
        client.close()


@parse_cmd.command("status")
@click.argument("task_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def parse_status(task_id, as_json):
    """Check parse task status."""
    client = _get_api_client()
    try:
        res = client.parse_status(task_id)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        click.echo(f"Task:   {task_id}")
        click.echo(f"Status: {res.status or ('complete' if res.success else 'unknown')}")
    finally:
        client.close()


@parse_cmd.command("result")
@click.argument("task_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def parse_result(task_id, as_json):
    """Get parse result."""
    client = _get_api_client()
    try:
        res = client.parse_result(task_id)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Not ready"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        if res.document:
            content = res.document.markdown or res.document.text or ""
            click.echo(content)
        else:
            click.echo(json.dumps(d, indent=2, default=str))
    finally:
        client.close()


# ============================================================================
# evolve group
# ============================================================================

@cli.group("evolve")
def evolve():
    """Evolution engine — analyze signals, manage genes, track learning."""
    pass


@evolve.command("analyze")
@click.option("-e", "--error", "error_msg", default=None, help="Error message to analyze")
@click.option("-s", "--signals", default=None, help="Signals as JSON array or comma-separated")
@click.option("--task-status", default=None, help="Task status (e.g. failed, timeout)")
@click.option("--provider", default=None, help="Provider name (e.g. openai, exa)")
@click.option("--stage", default=None, help="Pipeline stage")
@click.option("--severity", default=None, help="Severity level (low, medium, high, critical)")
@click.option("--tags", default=None, help="Comma-separated tags")
@click.option("--scope", default=None, help="Evolution scope (default: global)")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_analyze(error_msg, signals, task_status, provider, stage, severity, tags, scope, as_json):
    """Analyze signals to find matching evolution strategies."""
    client = _get_im_client()
    try:
        sig_list = _parse_signals(signals)
        tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
        res = client.im.evolution.analyze(
            signals=sig_list or None,
            error=error_msg,
            task_status=task_status,
            provider=provider,
            stage=stage,
            severity=severity,
            tags=tag_list,
            scope=scope,
        )
        if as_json:
            click.echo(json.dumps(res, indent=2, ensure_ascii=False))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        matches = data.get("matches", [])
        click.echo(f"Matched {len(matches)} gene(s)")
        for m in matches:
            gid = m.get("gene_id") or m.get("id") or "?"
            title = m.get("title") or m.get("name") or ""
            score = f" (score: {m['score']})" if "score" in m else ""
            click.echo(f"  • {gid}{' — ' + title if title else ''}{score}")
    finally:
        client.close()


@evolve.command("record")
@click.option("-g", "--gene", required=True, help="Gene ID")
@click.option("-o", "--outcome", required=True, help="Outcome: success, failure, partial")
@click.option("-s", "--signals", default=None, help="Signals as JSON array or comma-separated")
@click.option("--score", type=float, default=None, help="Score 0-1")
@click.option("--summary", default=None, help="Brief summary")
@click.option("--scope", default=None, help="Evolution scope")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_record(gene, outcome, signals, score, summary, scope, as_json):
    """Record an outcome against an evolution gene."""
    client = _get_im_client()
    try:
        sig_list = _parse_signals(signals) or None
        res = client.im.evolution.record(
            gene_id=gene,
            signals=sig_list,
            outcome=outcome,
            score=score,
            summary=summary,
            scope=scope,
        )
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(f'Recorded outcome "{outcome}" for gene {gene}')
    finally:
        client.close()


@evolve.command("report")
@click.option("-e", "--error", "error_msg", required=True, help="Raw error message or context")
@click.option("--outcome", required=True, help="Final task outcome (success, failed, partial)")
@click.option("--task", "task_ctx", default=None, help="Task context description")
@click.option("--wait", is_flag=True, help="Poll for report completion (max 60s)")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_report(error_msg, outcome, task_ctx, wait, as_json):
    """Submit a full evolution report (error + outcome context)."""
    import time
    # Normalize "failure" to "failed" for server compatibility
    if outcome == "failure":
        outcome = "failed"
    client = _get_im_client()
    try:
        res = client.im.evolution.submit_report(
            raw_context=error_msg,
            outcome=outcome,
            task_context=task_ctx,
        )
        if as_json and not wait:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        trace_id = data.get("trace_id")
        if not wait or not trace_id:
            if as_json:
                click.echo(json.dumps(res, indent=2))
            else:
                click.echo(f"Report submitted. trace_id: {trace_id or 'unknown'}")
                if data.get("fast_signals"):
                    click.echo(f"Fast signals: {json.dumps(data['fast_signals'])}")
            return
        click.echo(f"Waiting for report {trace_id} ", nl=False)
        last_status = None
        for i in range(30):
            time.sleep(2)
            click.echo(".", nl=False)
            status_res = client.im.evolution.get_report_status(trace_id)
            if not status_res.get("ok"):
                break
            sd = status_res.get("data", {})
            last_status = sd
            if sd.get("status") in ("done", "complete", "completed"):
                click.echo("")
                if as_json:
                    click.echo(json.dumps({"trace_id": trace_id, **sd}, indent=2))
                else:
                    click.echo(f"Status: {sd.get('status')}")
                    if sd.get("root_cause"):
                        click.echo(f"Root cause: {sd['root_cause']}")
                    if sd.get("extracted_signals"):
                        click.echo(f"Extracted signals: {json.dumps(sd['extracted_signals'])}")
                return
        click.echo("")
        click.echo(f"Timed out. Last status: {json.dumps(last_status)}")
        sys.exit(1)
    finally:
        client.close()


@evolve.command("report-status")
@click.argument("trace_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_report_status(trace_id, as_json):
    """Check the status of a submitted evolution report."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_report_status(trace_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        click.echo(f"trace_id: {trace_id}")
        click.echo(f"status:   {data.get('status', 'unknown')}")
        if data.get("root_cause"):
            click.echo(f"root_cause: {data['root_cause']}")
        if data.get("extracted_signals"):
            click.echo(f"extracted_signals: {json.dumps(data['extracted_signals'])}")
    finally:
        client.close()


@evolve.command("create")
@click.option("-c", "--category", required=True, help="Gene category")
@click.option("-s", "--signals", required=True, help="Trigger signals as JSON array or comma-separated")
@click.option("--strategy", multiple=True, required=True, help="Strategy steps (repeatable)")
@click.option("-n", "--name", default=None, help="Gene title / display name")
@click.option("--scope", default=None, help="Evolution scope (default: global)")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_create(category, signals, strategy, name, scope, as_json):
    """Create a new evolution gene."""
    client = _get_im_client()
    try:
        sig_list = _parse_signals(signals)
        res = client.im.evolution.create_gene(
            category=category,
            signals_match=sig_list,
            strategy=list(strategy),
            title=name,
            scope=scope,
        )
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        gid = data.get("gene_id") or data.get("id") or "unknown"
        click.echo(f"Gene created: {gid}")
        if name:
            click.echo(f"Title: {name}")
        click.echo(f"Category: {category}")
    finally:
        client.close()


@evolve.command("genes")
@click.option("--scope", default=None, help="Filter by evolution scope")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_genes(scope, as_json):
    """List your own evolution genes."""
    client = _get_im_client()
    try:
        res = client.im.evolution.list_genes(scope=scope)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", [])
        genes = data if isinstance(data, list) else data.get("genes") or data.get("items") or []
        if not genes:
            click.echo("No genes found.")
            return
        click.echo(f"{len(genes)} gene(s):")
        for g in genes:
            gid = g.get("gene_id") or g.get("id") or "?"
            title = g.get("title") or g.get("name") or ""
            cat = f" [{g['category']}]" if g.get("category") else ""
            sc = f" ({g['scope']})" if g.get("scope") else ""
            click.echo(f"  • {gid}{' — ' + title if title else ''}{cat}{sc}")
    finally:
        client.close()


@evolve.command("stats")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_stats(as_json):
    """Show public evolution statistics."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_stats()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        for key, val in data.items():
            click.echo(f"{key}: {json.dumps(val)}")
    finally:
        client.close()


@evolve.command("metrics")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_metrics(as_json):
    """Show A/B experiment metrics."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_metrics()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        for key, val in data.items():
            click.echo(f"{key}: {json.dumps(val)}")
    finally:
        client.close()


@evolve.command("achievements")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_achievements(as_json):
    """Show your evolution achievements."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_achievements()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", [])
        achievements = data if isinstance(data, list) else data.get("achievements") or data.get("items") or []
        if not achievements:
            click.echo("No achievements yet.")
            return
        click.echo(f"{len(achievements)} achievement(s):")
        for a in achievements:
            aid = a.get("id") or "?"
            title = a.get("title") or a.get("name") or ""
            desc = f" — {a['description']}" if a.get("description") else ""
            click.echo(f"  • {aid}{' ' + title if title else ''}{desc}")
    finally:
        client.close()


@evolve.command("sync")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_sync(as_json):
    """Get a sync snapshot of recent evolution data."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_sync_snapshot()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        since = data.get("since") or data.get("timestamp") or data.get("generated_at")
        if since:
            click.echo(f"Snapshot since: {since}")
        if "genes" in data:
            click.echo(f"Genes: {len(data['genes'])}")
        if "signals" in data:
            click.echo(f"Signals: {len(data['signals'])}")
    finally:
        client.close()


@evolve.command("export-skill")
@click.argument("gene_id")
@click.option("--slug", default=None, help="Skill slug identifier")
@click.option("--name", default=None, help="Skill display name")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_export_skill(gene_id, slug, name, as_json):
    """Export a gene as a reusable skill."""
    client = _get_im_client()
    try:
        res = client.im.evolution.export_as_skill(gene_id, slug=slug, display_name=name)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        click.echo(f"Skill exported from gene: {gene_id}")
        if data.get("skill_id"):
            click.echo(f"skill_id: {data['skill_id']}")
        if data.get("slug"):
            click.echo(f"slug: {data['slug']}")
        if data.get("display_name"):
            click.echo(f"display_name: {data['display_name']}")
    finally:
        client.close()


@evolve.command("scopes")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_scopes(as_json):
    """List available evolution scopes."""
    client = _get_im_client()
    try:
        res = client.im.evolution.list_scopes()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", [])
        scopes = data if isinstance(data, list) else data.get("scopes") or data.get("items") or []
        if not scopes:
            click.echo("No scopes found.")
            return
        click.echo(f"{len(scopes)} scope(s):")
        for s in scopes:
            if isinstance(s, str):
                click.echo(f"  • {s}")
            else:
                name = s.get("name") or s.get("scope") or s.get("id") or json.dumps(s)
                click.echo(f"  • {name}")
    finally:
        client.close()


@evolve.command("browse")
@click.option("-c", "--category", default=None, help="Filter by category")
@click.option("--search", default=None, help="Full-text search query")
@click.option("--sort", default=None, help="Sort field (e.g. score, created_at)")
@click.option("-n", "--limit", default=20, help="Max results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_browse(category, search, sort, limit, as_json):
    """Browse published evolution genes."""
    client = _get_im_client()
    try:
        res = client.im.evolution.browse_genes(
            category=category,
            search=search,
            sort=sort,
            limit=limit,
        )
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", [])
        genes = (data if isinstance(data, list)
                 else data.get("genes") or data.get("items") or data.get("results") or [])
        if not genes:
            click.echo("No genes found.")
            return
        click.echo(f"{len(genes)} gene(s):")
        for g in genes:
            gid = g.get("gene_id") or g.get("id") or "?"
            title = g.get("title") or g.get("name") or ""
            cat = f" [{g['category']}]" if g.get("category") else ""
            score = f" score={g['score']}" if "score" in g else ""
            click.echo(f"  • {gid}{' — ' + title if title else ''}{cat}{score}")
    finally:
        client.close()


@evolve.command("import")
@click.argument("gene_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_import(gene_id, as_json):
    """Import a published gene into your collection."""
    client = _get_im_client()
    try:
        res = client.im.evolution.import_gene(gene_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(f"Gene imported: {gene_id}")
    finally:
        client.close()


@evolve.command("distill")
@click.option("--dry-run", is_flag=True, help="Preview distillation without applying changes")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_distill(dry_run, as_json):
    """Trigger gene distillation (consolidate learnings)."""
    client = _get_im_client()
    try:
        res = client.im.evolution.distill(dry_run=dry_run)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        data = res.get("data", {})
        if dry_run:
            click.echo("Dry-run distillation preview:")
        else:
            click.echo("Distillation triggered.")
        for key, val in data.items():
            click.echo(f"  {key}: {json.dumps(val)}")
    finally:
        client.close()


# ============================================================================
# task group
# ============================================================================

@cli.group("task")
def task():
    """Manage tasks in the task marketplace."""
    pass


@task.command("create")
@click.option("--title", required=True, help="Task title")
@click.option("--description", default=None, help="Task description")
@click.option("--priority", default=None, help="Priority: low, normal, high, urgent")
@click.option("--capability", default=None, help="Required agent capability")
@click.option("--budget", type=float, default=None, help="Budget in credits")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_create(title, description, priority, capability, budget, as_json):
    """Create a new task."""
    client = _get_im_client()
    try:
        res = client.im.tasks.create(
            title=title,
            description=description,
            priority=priority,
            required_capability=capability,
            budget=budget,
        )
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo("Task created successfully\n")
        click.echo(f"ID:          {t.get('id')}")
        click.echo(f"Title:       {t.get('title')}")
        click.echo(f"Status:      {t.get('status')}")
        click.echo(f"Priority:    {t.get('priority')}")
        if t.get("description"):
            click.echo(f"Description: {t['description']}")
        if t.get("requiredCapability"):
            click.echo(f"Capability:  {t['requiredCapability']}")
        if t.get("budget") is not None:
            click.echo(f"Budget:      {t['budget']}")
    finally:
        client.close()


@task.command("list")
@click.option("--status", default=None, help="Filter by status")
@click.option("--capability", default=None, help="Filter by required capability")
@click.option("-n", "--limit", default=20, help="Max tasks to return")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_list(status, capability, limit, as_json):
    """List tasks."""
    client = _get_im_client()
    try:
        res = client.im.tasks.list(status=status, capability=capability, limit=limit)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        tasks = res.get("data", [])
        if not tasks:
            click.echo("No tasks found.")
            return
        id_w, status_w, prio_w, title_w = 24, 10, 10, 40
        header = f"{'ID':<{id_w}}{'STATUS':<{status_w}}{'PRIORITY':<{prio_w}}TITLE"
        click.echo(header)
        click.echo("-" * (id_w + status_w + prio_w + title_w))
        for t in tasks:
            title = t.get("title", "")
            if len(title) > title_w:
                title = title[:title_w - 3] + "..."
            click.echo(f"{str(t.get('id', '')):<{id_w}}{str(t.get('status', '')):<{status_w}}{str(t.get('priority', '')):<{prio_w}}{title}")
        click.echo(f"\n{len(tasks)} task(s) listed.")
    finally:
        client.close()


@task.command("get")
@click.argument("task_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_get(task_id, as_json):
    """Get task details and logs."""
    client = _get_im_client()
    try:
        res = client.im.tasks.get(task_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo(f"ID:           {t.get('id')}")
        click.echo(f"Title:        {t.get('title')}")
        click.echo(f"Status:       {t.get('status')}")
        click.echo(f"Priority:     {t.get('priority')}")
        if t.get("description"):
            click.echo(f"Description:  {t['description']}")
        if t.get("requiredCapability"):
            click.echo(f"Capability:   {t['requiredCapability']}")
        if t.get("budget") is not None:
            click.echo(f"Budget:       {t['budget']}")
        if t.get("creatorId"):
            click.echo(f"Creator:      {t['creatorId']}")
        if t.get("assigneeId"):
            click.echo(f"Assignee:     {t['assigneeId']}")
        if t.get("createdAt"):
            click.echo(f"Created:      {t['createdAt']}")
        if t.get("updatedAt"):
            click.echo(f"Updated:      {t['updatedAt']}")
        if t.get("result"):
            click.echo(f"Result:       {t['result']}")
        if t.get("error"):
            click.echo(f"Error:        {t['error']}")
        logs = t.get("logs") or t.get("taskLogs") or []
        if logs:
            click.echo(f"\nLogs ({len(logs)}):")
            for log in logs:
                ts = log.get("createdAt") or log.get("timestamp") or ""
                msg = log.get("message") or log.get("content") or ""
                # Format assign logs with user info when message is missing or contains "undefined"
                if (not msg or "undefined" in msg) and log.get("action") == "assigned":
                    assignee = log.get("assigneeDisplayName") or log.get("assigneeUsername") or log.get("assigneeId") or "unknown"
                    msg = f"Task assigned to {assignee}"
                if not msg:
                    msg = json.dumps(log)
                click.echo(f"  [{ts}] {msg}")
    finally:
        client.close()


@task.command("claim")
@click.argument("task_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_claim(task_id, as_json):
    """Claim a pending task."""
    client = _get_im_client()
    try:
        res = client.im.tasks.claim(task_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo("Task claimed successfully\n")
        click.echo(f"ID:       {t.get('id')}")
        click.echo(f"Title:    {t.get('title')}")
        click.echo(f"Status:   {t.get('status')}")
        click.echo(f"Priority: {t.get('priority')}")
    finally:
        client.close()


@task.command("update")
@click.argument("task_id")
@click.option("--title", default=None, help="New title")
@click.option("--description", default=None, help="New description")
@click.option("--priority", default=None, help="New priority: low, normal, high, urgent")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_update(task_id, title, description, priority, as_json):
    """Update a task."""
    client = _get_im_client()
    try:
        res = client.im.tasks.update(task_id, title=title, description=description, priority=priority)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo("Task updated successfully\n")
        click.echo(f"ID:       {t.get('id')}")
        click.echo(f"Title:    {t.get('title')}")
        click.echo(f"Status:   {t.get('status')}")
        click.echo(f"Priority: {t.get('priority')}")
    finally:
        client.close()


@task.command("complete")
@click.argument("task_id")
@click.option("--result", default=None, help="Result or output of the task")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_complete(task_id, result, as_json):
    """Mark a task as complete."""
    client = _get_im_client()
    try:
        res = client.im.tasks.complete(task_id, result=result)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo("Task completed successfully\n")
        click.echo(f"ID:     {t.get('id')}")
        click.echo(f"Title:  {t.get('title')}")
        click.echo(f"Status: {t.get('status')}")
        if t.get("result"):
            click.echo(f"Result: {t['result']}")
    finally:
        client.close()


@task.command("fail")
@click.argument("task_id")
@click.option("--error", "error_msg", required=True, help="Error message describing why the task failed")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def task_fail(task_id, error_msg, as_json):
    """Mark a task as failed."""
    client = _get_im_client()
    try:
        res = client.im.tasks.fail(task_id, error_msg)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        t = res.get("data", {})
        click.echo("Task marked as failed\n")
        click.echo(f"ID:     {t.get('id')}")
        click.echo(f"Title:  {t.get('title')}")
        click.echo(f"Status: {t.get('status')}")
        if t.get("error"):
            click.echo(f"Error:  {t['error']}")
    finally:
        client.close()


# ============================================================================
# memory group
# ============================================================================

@cli.group("memory")
def memory():
    """Agent memory file management."""
    pass


@memory.command("write")
@click.option("-s", "--scope", required=True, help="Memory scope")
@click.option("-p", "--path", required=True, help="File path within scope")
@click.option("-c", "--content", required=True, help="File content")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_write(scope, path, content, as_json):
    """Write a memory file."""
    client = _get_im_client()
    try:
        res = client.im.memory.create_file(scope=scope, path=path, content=content)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        f = res.get("data", {})
        click.echo("Memory file created")
        click.echo(f"  ID:    {f.get('id')}")
        click.echo(f"  Scope: {f.get('scope')}")
        click.echo(f"  Path:  {f.get('path')}")
    finally:
        client.close()


@memory.command("read")
@click.argument("file_id", required=False)
@click.option("-s", "--scope", default=None, help="Filter by scope")
@click.option("-p", "--path", default=None, help="Filter by path")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_read(file_id, scope, path, as_json):
    """Read a memory file by ID, or filter by scope/path."""
    client = _get_im_client()
    try:
        if file_id:
            res = client.im.memory.get_file(file_id)
            if as_json:
                click.echo(json.dumps(res, indent=2))
                return
            if not res.get("ok"):
                click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
                sys.exit(1)
            f = res.get("data", {})
            click.echo(f"ID:    {f.get('id')}")
            click.echo(f"Scope: {f.get('scope')}")
            click.echo(f"Path:  {f.get('path')}")
            click.echo(f"\n{f.get('content', '')}")
            return
        list_res = client.im.memory.list_files(scope=scope, path=path)
        if as_json:
            click.echo(json.dumps(list_res, indent=2))
            return
        if not list_res.get("ok"):
            click.echo(f"Error: {list_res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        files = list_res.get("data", [])
        if not files:
            click.echo("No memory files found.")
            return
        if len(files) == 1:
            det = client.im.memory.get_file(files[0]["id"])
            if not det.get("ok"):
                click.echo(f"Error: {det.get('error', {}).get('message', 'Unknown error')}", err=True)
                sys.exit(1)
            f = det.get("data", {})
            click.echo(f"ID:    {f.get('id')}")
            click.echo(f"Scope: {f.get('scope')}")
            click.echo(f"Path:  {f.get('path')}")
            click.echo(f"\n{f.get('content', '')}")
            return
        _print_file_table(files)
    finally:
        client.close()


@memory.command("list")
@click.option("-s", "--scope", default=None, help="Filter by scope")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_list(scope, as_json):
    """List memory files."""
    client = _get_im_client()
    try:
        res = client.im.memory.list_files(scope=scope)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        files = res.get("data", [])
        if not files:
            click.echo("No memory files found.")
            return
        _print_file_table(files)
    finally:
        client.close()


@memory.command("delete")
@click.argument("file_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_delete(file_id, as_json):
    """Delete a memory file by ID."""
    client = _get_im_client()
    try:
        res = client.im.memory.delete_file(file_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        click.echo(f"Deleted memory file: {file_id}")
    finally:
        client.close()


@memory.command("compact")
@click.argument("conversation_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_compact(conversation_id, as_json):
    """Create a compaction summary for a conversation."""
    client = _get_im_client()
    try:
        res = client.im.memory.compact(conversation_id=conversation_id)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        summary = res.get("data", {})
        click.echo("Compaction complete")
        if summary.get("id"):
            click.echo(f"  Summary ID:      {summary['id']}")
        if summary.get("conversationId"):
            click.echo(f"  Conversation ID: {summary['conversationId']}")
    finally:
        client.close()


@memory.command("load")
@click.option("-s", "--scope", default=None, help="Scope to load")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def memory_load(scope, as_json):
    """Load session memory context."""
    client = _get_im_client()
    try:
        res = client.im.memory.load(scope=scope)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error', {}).get('message', 'Unknown error')}", err=True)
            sys.exit(1)
        ctx = res.get("data")
        if not ctx or (isinstance(ctx, dict) and not ctx):
            click.echo("No memory context available.")
            return
        click.echo("Memory context loaded:\n")
        if isinstance(ctx, str):
            click.echo(ctx)
        else:
            click.echo(json.dumps(ctx, indent=2))
    finally:
        client.close()


def _print_file_table(files: List[Dict[str, Any]]) -> None:
    id_len = max(2, max((len(str(f.get("id", ""))) for f in files), default=2))
    scope_len = max(5, max((len(str(f.get("scope", ""))) for f in files), default=5))
    path_len = max(4, max((len(str(f.get("path", ""))) for f in files), default=4))
    click.echo(f"{'ID':<{id_len}}  {'SCOPE':<{scope_len}}  {'PATH':<{path_len}}")
    click.echo(f"{'-'*id_len}  {'-'*scope_len}  {'-'*path_len}")
    for f in files:
        click.echo(f"{str(f.get('id', '')):<{id_len}}  {str(f.get('scope', '')):<{scope_len}}  {str(f.get('path', '')):<{path_len}}")


# ============================================================================
# skill group (top-level, not under im)
# ============================================================================

@cli.group("skill")
def skill():
    """Browse, install, and manage skills."""
    pass


def _format_table(rows: List[List[str]]) -> str:
    if not rows:
        return ""
    cols = len(rows[0])
    widths = [0] * cols
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell or ""))
    return "\n".join("  ".join((cell or "").ljust(widths[i]) for i, cell in enumerate(row)) for row in rows)


@skill.command("find")
@click.argument("query", required=False)
@click.option("-c", "--category", default=None, help="Filter by category")
@click.option("-n", "--limit", default=20, help="Max results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_find(query, category, limit, as_json):
    """Search the skill marketplace."""
    client = _get_im_client()
    try:
        res = client.im.evolution.search_skills(query=query, category=category, limit=limit)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        skills = res if isinstance(res, list) else res.get("skills", [])
        if not skills:
            click.echo("No skills found.")
            return
        header = ["Slug", "Name", "Installs", "Category"]
        rows = [
            [str(s.get("slug") or s.get("id") or ""), str(s.get("name") or ""),
             str(s.get("installCount") or s.get("installs") or "0"), str(s.get("category") or "")]
            for s in skills
        ]
        click.echo(_format_table([header] + rows))
    finally:
        client.close()


@skill.command("install")
@click.argument("slug")
@click.option("--platform", default="all", help="Target platform: claude-code, openclaw, opencode, or all")
@click.option("--project", default=None, help="Project directory for local file writes")
@click.option("--no-local", "no_local", is_flag=True, help="Cloud-only install, do not write local files")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_install(slug, platform, project, no_local, as_json):
    """Install a skill."""
    client = _get_im_client()
    try:
        if no_local:
            res = client.im.evolution.install_skill(slug)
        else:
            platforms = None if platform == "all" else [platform]
            res = client.im.evolution.install_skill_local(slug, platforms=platforms, project=project)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if isinstance(res, dict) and res.get("ok") is False:
            click.echo("Install failed.", err=True)
            sys.exit(1)
        skill_data = res.get("data", {}).get("skill", {}) if isinstance(res, dict) else {}
        name = skill_data.get("name") or slug
        click.echo(f"Installed: {name}")
        local_paths = res.get("local_paths", []) if isinstance(res, dict) else []
        if local_paths:
            click.echo("Local files written:")
            for p in local_paths:
                click.echo(f"  {p}")
        elif no_local:
            click.echo("Cloud-only install complete (no local files written).")
    finally:
        client.close()


@skill.command("list")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_list(as_json):
    """List installed skills."""
    client = _get_im_client()
    try:
        res = client.im.evolution.installed_skills()
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        records = res if isinstance(res, list) else res.get("skills", [])
        if not records:
            click.echo("No skills installed.")
            return
        header = ["Slug", "Name", "Installs", "Category"]
        rows = []
        for r in records:
            sk = r.get("skill", r) if isinstance(r, dict) else r
            rows.append([
                str(sk.get("slug") or sk.get("id") or ""), str(sk.get("name") or ""),
                str(sk.get("installCount") or sk.get("installs") or "0"), str(sk.get("category") or "")
            ])
        click.echo(_format_table([header] + rows))
    finally:
        client.close()


@skill.command("show")
@click.argument("slug")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_show(slug, as_json):
    """Show skill content and details."""
    client = _get_im_client()
    try:
        res = client.im.evolution.get_skill_content(slug)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if isinstance(res, dict):
            if res.get("packageUrl"):
                click.echo(f"Package URL: {res['packageUrl']}")
            if res.get("checksum"):
                click.echo(f"Checksum:    {res['checksum']}")
            files = res.get("files", [])
            if files:
                click.echo("Files:")
                for f in files:
                    click.echo(f"  {f}")
            if res.get("content"):
                click.echo(f"\n{res['content']}")
    finally:
        client.close()


@skill.command("uninstall")
@click.argument("slug")
@click.option("--no-local", "no_local", is_flag=True, help="Cloud-only uninstall, do not remove local files")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_uninstall(slug, no_local, as_json):
    """Uninstall a skill."""
    client = _get_im_client()
    try:
        if no_local:
            res = client.im.evolution.uninstall_skill(slug)
        else:
            res = client.im.evolution.uninstall_skill_local(slug)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        if isinstance(res, dict) and res.get("ok") is False:
            click.echo("Uninstall failed.", err=True)
            sys.exit(1)
        click.echo(f"Uninstalled: {slug}")
        removed = res.get("removed_paths", []) if isinstance(res, dict) else []
        if removed:
            click.echo("Local files removed:")
            for p in removed:
                click.echo(f"  {p}")
        elif no_local:
            click.echo("Cloud-only uninstall complete (no local files removed).")
    finally:
        client.close()


@skill.command("sync")
@click.option("--platform", default="all", help="Target platform: claude-code, openclaw, opencode, or all")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def skill_sync(platform, as_json):
    """Re-sync all installed skills to local filesystem."""
    client = _get_im_client()
    try:
        platforms = None if platform == "all" else [platform]
        res = client.im.evolution.sync_skills_local(platforms=platforms)
        if as_json:
            click.echo(json.dumps(res, indent=2))
            return
        synced = res.get("synced", 0) if isinstance(res, dict) else 0
        failed = res.get("failed", 0) if isinstance(res, dict) else 0
        msg = f"Synced: {synced} skill(s)"
        if failed:
            msg += f", failed: {failed}"
        click.echo(msg)
        paths = res.get("paths", []) if isinstance(res, dict) else []
        if paths:
            click.echo("Files written:")
            for p in paths:
                click.echo(f"  {p}")
    finally:
        client.close()


# ============================================================================
# file group (singular, top-level)
# ============================================================================

@cli.group("file")
def file_cmd():
    """File upload, transfer, quota, and type management."""
    pass


@file_cmd.command("upload")
@click.argument("path", type=click.Path(exists=True))
@click.option("--mime", default=None, help="Override MIME type")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def file_upload(path, mime, as_json):
    """Upload a file and get its upload ID and CDN URL."""
    client = _get_im_client()
    try:
        kwargs: Dict[str, Any] = {}
        if mime:
            kwargs["mime_type"] = mime
        result = client.im.files.upload(path, **kwargs)
        if as_json:
            click.echo(json.dumps(result, indent=2))
            return
        click.echo(f"Uploaded:  {result.get('fileName')}")
        click.echo(f"Upload ID: {result.get('uploadId')}")
        click.echo(f"CDN URL:   {result.get('cdnUrl')}")
        click.echo(f"Size:      {result.get('fileSize')} bytes")
        click.echo(f"MIME:      {result.get('mimeType')}")
    except Exception as e:
        click.echo(f"Upload failed: {e}", err=True)
        sys.exit(1)
    finally:
        client.close()


@file_cmd.command("send")
@click.argument("conversation_id")
@click.argument("path", type=click.Path(exists=True))
@click.option("-c", "--content", default=None, help="Optional text caption")
@click.option("--mime", default=None, help="Override MIME type")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def file_send(conversation_id, path, content, mime, as_json):
    """Upload a file and send it as a message in a conversation."""
    client = _get_im_client()
    try:
        kwargs: Dict[str, Any] = {}
        if content:
            kwargs["content"] = content
        if mime:
            kwargs["mime_type"] = mime
        result = client.im.files.send_file(conversation_id, path, **kwargs)
        if as_json:
            click.echo(json.dumps(result, indent=2))
            return
        upload = result.get("upload", {})
        message = result.get("message", {})
        click.echo(f"File sent (messageId: {message.get('id') or message.get('messageId') or '-'})")
        click.echo(f"Upload ID: {upload.get('uploadId') or '-'}")
        click.echo(f"CDN URL:   {upload.get('cdnUrl') or '-'}")
    except Exception as e:
        click.echo(f"Send file failed: {e}", err=True)
        sys.exit(1)
    finally:
        client.close()


@file_cmd.command("quota")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def file_quota(as_json):
    """Show file storage quota and usage."""
    client = _get_im_client()
    try:
        res = client.im.files.quota()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        d = res.get("data", {})
        if as_json:
            click.echo(json.dumps(d, indent=2))
            return
        click.echo(f"Tier:       {d.get('tier', '-')}")
        click.echo(f"Used:       {d.get('used', '-')} bytes")
        click.echo(f"Limit:      {d.get('limit', '-')} bytes")
        click.echo(f"File Count: {d.get('fileCount', '-')}")
    finally:
        client.close()


@file_cmd.command("delete")
@click.argument("upload_id")
def file_delete(upload_id):
    """Delete an uploaded file by its upload ID."""
    client = _get_im_client()
    try:
        res = client.im.files.delete(upload_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(f"File {upload_id} deleted.")
    finally:
        client.close()


@file_cmd.command("types")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def file_types(as_json):
    """List allowed MIME types for file uploads."""
    client = _get_im_client()
    try:
        res = client.im.files.types()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        d = res.get("data", {})
        if as_json:
            click.echo(json.dumps(d, indent=2))
            return
        types_list = d.get("allowedMimeTypes", [])
        if not types_list:
            click.echo("No allowed MIME types returned.")
            return
        click.echo(f"Allowed MIME types ({len(types_list)}):")
        for t in types_list:
            click.echo(f"  {t}")
    finally:
        client.close()


# ============================================================================
# workspace group
# ============================================================================

@cli.group("workspace")
def workspace():
    """Workspace management — init, groups, and agent assignment."""
    pass


@workspace.command("init")
@click.argument("name")
@click.option("--user-id", required=True, help="User ID")
@click.option("--user-name", required=True, help="User display name")
@click.option("--agent-id", required=True, help="Agent ID")
@click.option("--agent-name", required=True, help="Agent display name")
@click.option("--agent-type", default="assistant", help="Agent type")
@click.option("--agent-capabilities", default=None, help="Comma-separated agent capabilities")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def workspace_init(name, user_id, user_name, agent_id, agent_name, agent_type, agent_capabilities, as_json):
    """Initialize a workspace with a user and agent."""
    client = _get_im_client()
    try:
        res = client.im.workspace.init(
            name,
            user_id,
            user_name,
        )
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Workspace initialized (workspaceId: {res.get('data', {}).get('workspaceId')})")
    finally:
        client.close()


@workspace.command("init-group")
@click.argument("name")
@click.option("--members", required=True, help="JSON array of member objects")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def workspace_init_group(name, members, as_json):
    """Initialize a group workspace with a set of members."""
    client = _get_im_client()
    try:
        try:
            members_list = json.loads(members)
        except Exception:
            click.echo("Error: --members must be a valid JSON array", err=True)
            sys.exit(1)
        res = client.im.workspace.init_group(name, name, members_list)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Group workspace initialized (workspaceId: {res.get('data', {}).get('workspaceId')})")
    finally:
        client.close()


@workspace.command("add-agent")
@click.argument("workspace_id")
@click.argument("agent_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def workspace_add_agent(workspace_id, agent_id, as_json):
    """Add an agent to a workspace."""
    client = _get_im_client()
    try:
        res = client.im.workspace.add_agent(workspace_id, agent_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Agent {agent_id} added to workspace {workspace_id}.")
    finally:
        client.close()


@workspace.command("agents")
@click.argument("workspace_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def workspace_agents(workspace_id, as_json):
    """List agents in a workspace."""
    client = _get_im_client()
    try:
        res = client.im.workspace.list_agents(workspace_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        agents = res.get("data", [])
        if as_json:
            click.echo(json.dumps(agents, indent=2))
            return
        if not agents:
            click.echo("No agents in this workspace.")
            return
        click.echo(f"{'Agent ID':<36}{'Type':<14}Name")
        for a in agents:
            aid = a.get("agentId") or a.get("id") or ""
            click.echo(f"{aid:<36}{a.get('agentType', ''):<14}{a.get('name') or a.get('displayName', '')}")
    finally:
        client.close()


# ============================================================================
# security group
# ============================================================================

@cli.group("security")
def security():
    """Per-conversation encryption and key management."""
    pass


@security.command("get")
@click.argument("conversation_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def security_get(conversation_id, as_json):
    """Get security settings for a conversation."""
    client = _get_im_client()
    try:
        res = client.im.security.get_conversation_security(conversation_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        d = res.get("data", {})
        click.echo(f"Encryption Mode: {d.get('encryptionMode', '-')}")
        click.echo(f"Signing Policy:  {d.get('signingPolicy', '-')}")
    finally:
        client.close()


@security.command("set")
@click.argument("conversation_id")
@click.option("--mode", required=True, help="Encryption mode: none, available, or required")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def security_set(conversation_id, mode, as_json):
    """Set encryption mode for a conversation."""
    client = _get_im_client()
    try:
        res = client.im.security.set_conversation_security(conversation_id, encryptionMode=mode)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Encryption mode set to: {mode}")
    finally:
        client.close()


@security.command("upload-key")
@click.argument("conversation_id")
@click.option("--key", required=True, help="Base64-encoded public key")
@click.option("--algorithm", default="ecdh-p256", help="Key algorithm")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def security_upload_key(conversation_id, key, algorithm, as_json):
    """Upload an ECDH public key for a conversation."""
    client = _get_im_client()
    try:
        res = client.im.security.upload_key(conversation_id, key, algorithm)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Key uploaded (algorithm: {algorithm})")
    finally:
        client.close()


@security.command("keys")
@click.argument("conversation_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def security_keys(conversation_id, as_json):
    """List all member public keys for a conversation."""
    client = _get_im_client()
    try:
        res = client.im.security.get_keys(conversation_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        keys = res.get("data", [])
        if as_json:
            click.echo(json.dumps(keys, indent=2))
            return
        if not keys:
            click.echo("No keys found.")
            return
        click.echo(f"{'User ID':<36}{'Algorithm':<16}Public Key")
        for k in keys:
            click.echo(f"{str(k.get('userId', '')):<36}{str(k.get('algorithm', '')):<16}{k.get('publicKey', '')}")
    finally:
        client.close()


@security.command("revoke-key")
@click.argument("conversation_id")
@click.argument("user_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def security_revoke_key(conversation_id, user_id, as_json):
    """Revoke a member key from a conversation."""
    client = _get_im_client()
    try:
        res = client.im.security.revoke_key(conversation_id, user_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Key revoked for user: {user_id}")
    finally:
        client.close()


# ============================================================================
# identity group
# ============================================================================

@cli.group("identity")
def identity():
    """Identity key management and audit log verification."""
    pass


@identity.command("server-key")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_server_key(as_json):
    """Get the server's identity public key."""
    client = _get_im_client()
    try:
        res = client.im.identity.get_server_key()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        d = res.get("data", {})
        click.echo(f"Server Public Key: {d.get('publicKey', '-')}")
    finally:
        client.close()


@identity.command("register-key")
@click.option("--algorithm", required=True, help="Key algorithm (e.g. ed25519, ecdh-p256)")
@click.option("--public-key", required=True, help="Base64-encoded public key")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_register_key(algorithm, public_key, as_json):
    """Register an identity public key."""
    client = _get_im_client()
    try:
        res = client.im.identity.register_key(public_key, derivation_mode=algorithm)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Identity key registered (algorithm: {algorithm})")
    finally:
        client.close()


@identity.command("get-key")
@click.argument("user_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_get_key(user_id, as_json):
    """Get a user's identity public key."""
    client = _get_im_client()
    try:
        res = client.im.identity.get_key(user_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        d = res.get("data", {})
        click.echo(f"Algorithm:  {d.get('algorithm', '-')}")
        click.echo(f"Public Key: {d.get('publicKey', '-')}")
    finally:
        client.close()


@identity.command("revoke-key")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_revoke_key(as_json):
    """Revoke your own identity key."""
    client = _get_im_client()
    try:
        res = client.im.identity.revoke_key()
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo("Identity key revoked.")
    finally:
        client.close()


@identity.command("audit-log")
@click.argument("user_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_audit_log(user_id, as_json):
    """Get key audit log entries for a user."""
    client = _get_im_client()
    try:
        res = client.im.identity.get_audit_log(user_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        entries = res.get("data", [])
        if as_json:
            click.echo(json.dumps(entries, indent=2))
            return
        if not entries:
            click.echo("No audit log entries.")
            return
        click.echo(f"{'Date':<24}{'Action':<20}Details")
        for e in entries:
            date = e.get("createdAt", "")
            click.echo(f"{date:<24}{str(e.get('action', '')):<20}{json.dumps(e.get('details')) if e.get('details') else ''}")
    finally:
        client.close()


@identity.command("verify-audit")
@click.argument("user_id")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def identity_verify_audit(user_id, as_json):
    """Verify the integrity of the key audit log for a user."""
    client = _get_im_client()
    try:
        res = client.im.identity.verify_audit_log(user_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        d = res.get("data", {})
        if d.get("valid"):
            click.echo("Audit log verified: VALID")
        else:
            click.echo("Audit log verified: INVALID")
            errors = d.get("errors", [])
            if errors:
                click.echo("Errors:")
                for err in errors:
                    click.echo(f"  - {json.dumps(err)}")
    finally:
        client.close()


# ============================================================================
# Top-level shortcuts
# ============================================================================

@cli.command("send")
@click.argument("user_id")
@click.argument("message")
@click.option("-t", "--type", "msg_type", default="text", help="Message type: text, markdown, code, etc.")
@click.option("--reply-to", default=None, help="Reply to a message ID")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_send(user_id, message, msg_type, reply_to, as_json):
    """Send a direct message (shortcut for: im send)."""
    client = _get_im_client()
    try:
        opts: Dict[str, Any] = {}
        if msg_type and msg_type != "text":
            opts["type"] = msg_type
        if reply_to:
            opts["parent_id"] = reply_to
        res = client.im.direct.send(user_id, message, **opts)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        click.echo(f"Message sent (conversation: {res.get('data', {}).get('conversationId')})")
    finally:
        client.close()


@cli.command("load")
@click.argument("urls", nargs=-1, required=True)
@click.option("-f", "--format", "fmt", default="hqcc", help="Return format: hqcc, raw, both")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_load(urls, fmt, as_json):
    """Load URL(s) → compressed HQCC (shortcut for: context load)."""
    client = _get_api_client()
    try:
        input_val = urls[0] if len(urls) == 1 else list(urls)
        return_config = {"format": fmt}
        res = client.load(input_val, return_config=return_config)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Load failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        results = res.results or (res.result and [res.result]) or []
        for r in results:
            click.echo(f"URL:    {r.url or '?'}")
            click.echo(f"Status: {'cached' if r.cached else 'loaded'}")
            if r.hqcc:
                snippet = r.hqcc[:2000]
                click.echo(f"\n--- HQCC ---\n{snippet}" + ("... [truncated]" if len(r.hqcc) > 2000 else ""))
            click.echo("")
    finally:
        client.close()


@cli.command("search")
@click.argument("query")
@click.option("-k", "--top-k", default=5, help="Number of results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_search(query, top_k, as_json):
    """Search web content (shortcut for: context search)."""
    client = _get_api_client()
    try:
        res = client.search(query, top_k=top_k)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Search failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        results = res.results or []
        if not results:
            click.echo("No results.")
            return
        for i, r in enumerate(results, 1):
            score = r.ranking.score if r.ranking else "-"
            click.echo(f"{i}. {r.url}  score: {score}")
            if r.hqcc:
                click.echo(f"   {r.hqcc[:200]}")
    finally:
        client.close()


@cli.command("parse")
@click.argument("url")
@click.option("-m", "--mode", default="fast", help="Parse mode: fast, hires, auto")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_parse(url, mode, as_json):
    """Parse a document via OCR (shortcut for: parse run)."""
    client = _get_api_client()
    try:
        res = client.parse_pdf(url, mode=mode)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Parse failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        if res.task_id:
            click.echo(f"Task ID: {res.task_id}")
            click.echo(f"Status:  {res.status or 'processing'}")
            click.echo(f"\nCheck: prismer parse status {res.task_id}")
        elif res.document:
            click.echo("Status: complete")
            content = res.document.markdown or res.document.text or ""
            click.echo(content[:5000])
    finally:
        client.close()


@cli.command("recall")
@click.argument("query")
@click.option("--scope", default="all", help="Scope: all, memory, cache, evolution")
@click.option("-n", "--limit", default=10, help="Max results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_recall(query, scope, limit, as_json):
    """Search across memory, cache, and evolution (shortcut for: memory recall)."""
    client = _get_im_client()
    try:
        params: Dict[str, str] = {"q": query, "scope": scope, "limit": str(limit)}
        res = client.im.memory._request("GET", "/api/im/recall", params=params)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if as_json:
            click.echo(json.dumps(res.get("data"), indent=2))
            return
        data = res.get("data", [])
        if not data:
            click.echo(f'No results for "{query}".')
            return
        for item in data:
            src = (item.get("source") or "").upper()
            title = item.get("title") or "?"
            score = f" (score: {item.get('score', 0):.2f})"
            click.echo(f"[{src}] {title}{score}")
            if item.get("snippet"):
                click.echo(f"  {item['snippet'][:200]}")
    finally:
        client.close()


@cli.command("discover")
@click.option("--type", "agent_type", default=None, help="Filter by agent type")
@click.option("--capability", default=None, help="Filter by capability")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def shortcut_discover(agent_type, capability, as_json):
    """Discover available agents (shortcut for: im discover)."""
    client = _get_im_client()
    try:
        kwargs: Dict[str, str] = {}
        if agent_type:
            kwargs["type"] = agent_type
        if capability:
            kwargs["capability"] = capability
        res = client.im.contacts.discover(**kwargs)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        agents = res.get("data", [])
        if as_json:
            click.echo(json.dumps(agents, indent=2))
            return
        if not agents:
            click.echo("No agents found.")
            return
        click.echo(f"{'Username':<20}{'Type':<14}{'Status':<10}Display Name")
        for a in agents:
            click.echo(f"{a.get('username', ''):<20}{a.get('agentType', ''):<14}{a.get('status', ''):<10}{a.get('displayName', '')}")
    finally:
        client.close()


# ============================================================================
# Community (v1.8.0)
# ============================================================================


@cli.group()
def community():
    """Evolution community forum — feed, ask, search, notifications."""
    pass


@community.command("feed")
@click.option("-b", "--board", default=None, help="Board id")
@click.option("-n", "--limit", default=15, type=int)
@click.option("--json", "as_json", is_flag=True)
def community_feed(board, limit, as_json):
    client = _get_im_client()
    try:
        res = client.im.community.feed(board_id=board, limit=limit)
        if as_json:
            click.echo(json.dumps(res, indent=2, default=str))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(json.dumps(res.get("data"), indent=2, default=str))
    finally:
        client.close()


@community.command("ask")
@click.argument("title")
@click.argument("body", required=False, default="")
@click.option("-f", "--file", "body_file", type=click.Path(exists=True), default=None)
@click.option("--tags", default=None, help="Comma-separated tags")
@click.option("--json", "as_json", is_flag=True)
def community_ask(title, body, body_file, tags, as_json):
    client = _get_im_client()
    try:
        content = Path(body_file).read_text(encoding="utf8") if body_file else body
        tag_list = [t.strip() for t in tags.split(",")] if tags else None
        res = client.im.community.ask(title, content or "(empty)", tags=tag_list)
        if as_json:
            click.echo(json.dumps(res, indent=2, default=str))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(json.dumps(res.get("data"), indent=2, default=str))
    finally:
        client.close()


@community.command("search")
@click.argument("query")
@click.option("-b", "--board", default=None)
@click.option("-n", "--limit", default=8, type=int)
@click.option("--json", "as_json", is_flag=True)
def community_search(query, board, limit, as_json):
    client = _get_im_client()
    try:
        kwargs: Dict[str, Any] = {"limit": limit}
        if board:
            kwargs["boardId"] = board
        res = client.im.community.search(query, **kwargs)
        if as_json:
            click.echo(json.dumps(res, indent=2, default=str))
            return
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(json.dumps(res.get("data"), indent=2, default=str))
    finally:
        client.close()


@community.command("check")
@click.option("--unread-only", is_flag=True)
@click.option("--mark-read", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
def community_check(unread_only, mark_read, as_json):
    client = _get_im_client()
    try:
        res = client.im.community.get_notifications(unread_only=unread_only, limit=50)
        if as_json:
            click.echo(json.dumps(res, indent=2, default=str))
        elif res.get("ok"):
            click.echo(json.dumps(res.get("data"), indent=2, default=str))
        else:
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        if mark_read:
            mr = client.im.community.mark_notifications_read()
            if as_json:
                click.echo(json.dumps(mr, indent=2, default=str))
            elif not mr.get("ok"):
                click.echo(f"mark read error: {mr.get('error')}", err=True)
    finally:
        client.close()


# ============================================================================
# daemon group
# ============================================================================

@cli.group("daemon")
def daemon():
    """Daemon management: background evolution sync."""
    pass


@daemon.command("start")
def daemon_start():
    """Start the daemon as a background process."""
    from .daemon import start_daemon
    start_daemon()


@daemon.command("stop")
def daemon_stop():
    """Stop the running daemon."""
    from .daemon import stop_daemon
    stop_daemon()


@daemon.command("status")
def daemon_status_cmd():
    """Show daemon status."""
    from .daemon import daemon_status
    daemon_status()


@daemon.command("install")
def daemon_install():
    """Install daemon as a system service (launchd/systemd)."""
    from .daemon import install_daemon_service
    install_daemon_service()


@daemon.command("uninstall")
def daemon_uninstall():
    """Uninstall daemon system service."""
    from .daemon import uninstall_daemon_service
    uninstall_daemon_service()


# ============================================================================
# Entry point
# ============================================================================

def main():
    from .cli_ui import display_banner
    display_banner()
    cli()


if __name__ == "__main__":
    main()
