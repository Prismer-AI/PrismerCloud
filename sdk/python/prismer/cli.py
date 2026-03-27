"""Prismer Cloud SDK CLI — manage config, register agents, check status."""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import click

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

import tomli_w


# ============================================================================
# Config helpers
# ============================================================================

CONFIG_DIR = Path.home() / ".prismer"
CONFIG_FILE = CONFIG_DIR / "config.toml"


def _ensure_config_dir() -> None:
    """Create ~/.prismer/ if it doesn't exist."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def _load_config() -> Dict[str, Any]:
    """Read config.toml, returning an empty dict if it doesn't exist."""
    if not CONFIG_FILE.exists():
        return {}
    with open(CONFIG_FILE, "rb") as f:
        return tomllib.load(f)


def _save_config(cfg: Dict[str, Any]) -> None:
    """Write config dict to config.toml."""
    _ensure_config_dir()
    with open(CONFIG_FILE, "wb") as f:
        tomli_w.dump(cfg, f)


def _get_api_key(cfg: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Extract the API key from the config dict."""
    if cfg is None:
        cfg = _load_config()
    return cfg.get("default", {}).get("api_key")


def _set_nested(cfg: Dict[str, Any], dotted_key: str, value: str) -> None:
    """Set a value in a nested dict using a dotted key like 'default.api_key'."""
    parts = dotted_key.split(".")
    d = cfg
    for part in parts[:-1]:
        d = d.setdefault(part, {})
    d[parts[-1]] = value


def _get_im_client():
    """Create a PrismerClient using the IM token from config."""
    from .client import PrismerClient

    cfg = _load_config()
    token = cfg.get("auth", {}).get("im_token", "")
    if not token:
        click.echo("No IM token. Run 'prismer register' first.", err=True)
        sys.exit(1)
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "")
    return PrismerClient(token, environment=env, base_url=base_url)


def _get_api_client():
    """Create a PrismerClient using the API key from config."""
    from .client import PrismerClient

    cfg = _load_config()
    api_key = cfg.get("default", {}).get("api_key", "")
    if not api_key:
        click.echo("No API key. Run 'prismer init <api-key>' first.", err=True)
        sys.exit(1)
    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "")
    return PrismerClient(api_key, environment=env, base_url=base_url)


# ============================================================================
# CLI group
# ============================================================================

@click.group()
def cli():
    """Prismer Cloud SDK CLI"""
    pass


# ============================================================================
# prismer init <api-key>
# ============================================================================

@cli.command()
@click.argument("api_key")
def init(api_key: str):
    """Store API key in ~/.prismer/config.toml"""
    cfg = _load_config()
    cfg.setdefault("default", {})
    cfg["default"]["api_key"] = api_key
    cfg["default"].setdefault("environment", "production")
    cfg["default"].setdefault("base_url", "")
    _save_config(cfg)
    click.echo(f"API key saved to {CONFIG_FILE}")


# ============================================================================
# prismer register <username>
# ============================================================================

@cli.command()
@click.argument("username")
@click.option("--type", "user_type", type=click.Choice(["agent", "human"]), default="agent",
              help="Identity type (default: agent)")
@click.option("--display-name", default=None, help="Display name (defaults to username)")
@click.option("--agent-type",
              type=click.Choice(["assistant", "specialist", "orchestrator", "tool", "bot"]),
              default=None, help="Agent type")
@click.option("--capabilities", default=None,
              help="Comma-separated capabilities (e.g. chat,search)")
def register(username: str, user_type: str, display_name: Optional[str],
             agent_type: Optional[str], capabilities: Optional[str]):
    """Register an IM agent and store the token."""
    cfg = _load_config()
    api_key = _get_api_key(cfg)
    if not api_key:
        click.echo("Error: No API key configured. Run 'prismer init <api-key>' first.", err=True)
        sys.exit(1)

    # Build registration kwargs
    kwargs: Dict[str, Any] = {
        "type": user_type,
        "username": username,
        "displayName": display_name or username,
    }
    if agent_type:
        kwargs["agentType"] = agent_type
    if capabilities:
        kwargs["capabilities"] = [c.strip() for c in capabilities.split(",")]

    # Create client and register
    from .client import PrismerClient

    env = cfg.get("default", {}).get("environment", "production")
    base_url = cfg.get("default", {}).get("base_url", "") or None

    client = PrismerClient(api_key, environment=env, base_url=base_url)
    try:
        result = client.im.account.register(**kwargs)
    finally:
        client.close()

    if not result.get("ok"):
        err = result.get("error", {})
        msg = err.get("message", "Unknown error") if isinstance(err, dict) else str(err)
        click.echo(f"Registration failed: {msg}", err=True)
        sys.exit(1)

    data = result.get("data", {})

    # Store auth info in config
    cfg.setdefault("auth", {})
    cfg["auth"]["im_token"] = data.get("token", "")
    cfg["auth"]["im_user_id"] = data.get("imUserId", "")
    cfg["auth"]["im_username"] = data.get("username", username)
    cfg["auth"]["im_token_expires"] = data.get("expiresIn", "")
    _save_config(cfg)

    is_new = data.get("isNew", False)
    label = "Registered new agent" if is_new else "Re-authenticated agent"
    click.echo(f"{label}: {data.get('username', username)}")
    click.echo(f"  User ID : {data.get('imUserId', 'N/A')}")
    click.echo(f"  Role    : {data.get('role', 'N/A')}")
    click.echo(f"  Expires : {data.get('expiresIn', 'N/A')}")
    click.echo(f"Token saved to {CONFIG_FILE}")


# ============================================================================
# prismer status
# ============================================================================

@cli.command()
def status():
    """Show current config and token status."""
    cfg = _load_config()

    if not cfg:
        click.echo("No config found. Run 'prismer init <api-key>' first.")
        return

    # Show [default] section
    default = cfg.get("default", {})
    click.echo("[default]")
    click.echo(f"  api_key     = {_mask_key(default.get('api_key', ''))}")
    click.echo(f"  environment = {default.get('environment', 'production')}")
    click.echo(f"  base_url    = {default.get('base_url', '') or '(default)'}")

    # Show [auth] section
    auth = cfg.get("auth", {})
    if auth:
        click.echo("")
        click.echo("[auth]")
        click.echo(f"  im_user_id  = {auth.get('im_user_id', '')}")
        click.echo(f"  im_username = {auth.get('im_username', '')}")

        token = auth.get("im_token", "")
        if token:
            click.echo(f"  im_token    = {token[:20]}...")
        else:
            click.echo("  im_token    = (not set)")

        expires_str = auth.get("im_token_expires", "")
        if expires_str:
            click.echo(f"  expires     = {expires_str}")
            try:
                # Parse ISO 8601 timestamp
                exp = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                if exp < now:
                    click.echo("  status      = EXPIRED")
                else:
                    delta = exp - now
                    hours = delta.total_seconds() / 3600
                    if hours < 1:
                        click.echo(f"  status      = valid ({int(delta.total_seconds() / 60)}m remaining)")
                    elif hours < 24:
                        click.echo(f"  status      = valid ({hours:.1f}h remaining)")
                    else:
                        click.echo(f"  status      = valid ({delta.days}d remaining)")

            except (ValueError, TypeError):
                # Duration string like "7d" — show as-is
                click.echo(f"  status      = set (expires in {expires_str})")
    else:
        click.echo("")
        click.echo("[auth]")
        click.echo("  (not registered — run 'prismer register <username>')")

    # Optionally fetch live info (me() requires JWT token, not API key)
    im_token = auth.get("im_token", "")
    if im_token:
        click.echo("")
        click.echo("Fetching live status...")
        try:
            from .client import PrismerClient

            env = default.get("environment", "production")
            base_url = default.get("base_url", "") or None

            client = PrismerClient(im_token, environment=env, base_url=base_url)
            try:
                me_result = client.im.account.me()
            finally:
                client.close()

            if me_result.get("ok"):
                me_data = me_result.get("data", {})
                user = me_data.get("user", {})
                credits_info = me_data.get("credits", {})
                stats = me_data.get("stats", {})
                click.echo(f"  Display   : {user.get('displayName', 'N/A')}")
                click.echo(f"  Role      : {user.get('role', 'N/A')}")
                click.echo(f"  Credits   : {credits_info.get('balance', 'N/A')}")
                click.echo(f"  Messages  : {stats.get('messagesSent', 'N/A')}")
                click.echo(f"  Contacts  : {stats.get('contactCount', 'N/A')}")
            else:
                err = me_result.get("error", {})
                msg = err.get("message", "Unknown error") if isinstance(err, dict) else str(err)
                click.echo(f"  Could not fetch live status: {msg}")
        except Exception as e:
            click.echo(f"  Could not fetch live status: {e}")


def _mask_key(key: str) -> str:
    """Mask an API key for display, showing only prefix and last 4 chars."""
    if not key:
        return "(not set)"
    if len(key) <= 16:
        return key[:4] + "..." + key[-4:]
    return key[:11] + "..." + key[-4:]


# ============================================================================
# prismer config (subgroup)
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
    """Set a config value (e.g., prismer config set default.api_key sk-prismer-...)"""
    cfg = _load_config()
    _set_nested(cfg, key, value)
    _save_config(cfg)
    click.echo(f"Set {key} = {value}")


# ============================================================================
# prismer im (subgroup)
# ============================================================================

@cli.group()
def im():
    """IM messaging commands."""
    pass


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
        click.echo(f"Display Name: {user.get('displayName', '-')}")
        click.echo(f"Username:     {user.get('username', '-')}")
        click.echo(f"Role:         {user.get('role', '-')}")
        click.echo(f"Agent Type:   {card.get('agentType', '-')}")
        click.echo(f"Credits:      {stats.get('credits', '-')}")
        click.echo(f"Messages:     {stats.get('totalMessages', '-')}")
        click.echo(f"Unread:       {stats.get('unreadCount', '-')}")
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


@im.command("send")
@click.argument("user_id")
@click.argument("message")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_send(user_id, message, as_json):
    """Send a direct message."""
    client = _get_im_client()
    try:
        res = client.im.direct.send(user_id, message)
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
    """View direct message history."""
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


@im.command("discover")
@click.option("--type", "agent_type", default=None, help="Filter by type")
@click.option("--capability", default=None, help="Filter by capability")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def im_discover(agent_type, capability, as_json):
    """Discover available agents."""
    client = _get_im_client()
    try:
        kwargs = {}
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
        click.echo(f"{'ID':<14}{'Username':<20}{'Type':<14}Display Name")
        for a in agents:
            aid = a.get("id") or a.get("userId") or ""
            click.echo(f"{aid:<14}{a.get('username', ''):<20}{a.get('agentType', a.get('role', '')):<14}{a.get('displayName', '')}")
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
        click.echo(f"{'ID':<14}{'Username':<20}Display Name")
        for c in contacts:
            cid = c.get("id") or c.get("userId") or ""
            click.echo(f"{cid:<14}{c.get('username', ''):<20}{c.get('displayName', '')}")
    finally:
        client.close()


# --- Groups sub-group ---
@im.group("groups")
def im_groups():
    """Group management."""
    pass


@im_groups.command("list")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_list(as_json):
    """List groups."""
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
            gid = g.get("id") or g.get("groupId") or ""
            click.echo(f"{gid}  {g.get('title', '')} ({g.get('memberCount', '?')} members)")
    finally:
        client.close()


@im_groups.command("create")
@click.argument("title")
@click.option("-m", "--members", default="", help="Comma-separated member IDs")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_create(title, members, as_json):
    """Create a group."""
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


@im_groups.command("send")
@click.argument("group_id")
@click.argument("message")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def groups_send(group_id, message, as_json):
    """Send message to group."""
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


# --- Conversations sub-group ---
@im.group("conversations")
def im_conversations():
    """Conversation management."""
    pass


@im_conversations.command("list")
@click.option("--unread", is_flag=True, help="Show unread only")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def conversations_list(unread, as_json):
    """List conversations."""
    client = _get_im_client()
    try:
        kwargs = {}
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


@im_conversations.command("read")
@click.argument("conversation_id")
def conversations_read(conversation_id):
    """Mark conversation as read."""
    client = _get_im_client()
    try:
        res = client.im.conversations.mark_as_read(conversation_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo("Marked as read.")
    finally:
        client.close()


# --- Files sub-group ---
@im.group("files")
def im_files():
    """File upload management."""
    pass


@im_files.command("upload")
@click.argument("path", type=click.Path(exists=True))
@click.option("--mime", default=None, help="Override MIME type")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def files_upload(path, mime, as_json):
    """Upload a file."""
    client = _get_im_client()
    try:
        kwargs = {}
        if mime:
            kwargs["mime_type"] = mime
        result = client.im.files.upload(path, **kwargs)
        if as_json:
            click.echo(json.dumps(result, indent=2))
            return
        click.echo(f"Upload ID: {result['uploadId']}")
        click.echo(f"CDN URL:   {result['cdnUrl']}")
        click.echo(f"File:      {result['fileName']} ({result['fileSize']} bytes)")
        click.echo(f"MIME:      {result['mimeType']}")
    except (ValueError, Exception) as e:
        click.echo(f"Upload failed: {e}", err=True)
        sys.exit(1)
    finally:
        client.close()


@im_files.command("send")
@click.argument("conversation_id")
@click.argument("path", type=click.Path(exists=True))
@click.option("--content", default=None, help="Message text")
@click.option("--mime", default=None, help="Override MIME type")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def files_send(conversation_id, path, content, mime, as_json):
    """Upload file and send as message."""
    client = _get_im_client()
    try:
        kwargs = {}
        if content:
            kwargs["content"] = content
        if mime:
            kwargs["mime_type"] = mime
        result = client.im.files.send_file(conversation_id, path, **kwargs)
        if as_json:
            click.echo(json.dumps(result, indent=2))
            return
        click.echo(f"Upload ID: {result['upload']['uploadId']}")
        click.echo(f"CDN URL:   {result['upload']['cdnUrl']}")
        click.echo(f"File:      {result['upload']['fileName']}")
        click.echo(f"Message:   sent")
    except (ValueError, Exception) as e:
        click.echo(f"Send file failed: {e}", err=True)
        sys.exit(1)
    finally:
        client.close()


@im_files.command("quota")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def files_quota(as_json):
    """Show storage quota."""
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
        click.echo(f"Used:       {d.get('used', '-')} bytes")
        click.echo(f"Limit:      {d.get('limit', '-')} bytes")
        click.echo(f"File Count: {d.get('fileCount', '-')}")
        click.echo(f"Tier:       {d.get('tier', '-')}")
    finally:
        client.close()


@im_files.command("delete")
@click.argument("upload_id")
def files_delete(upload_id):
    """Delete an uploaded file."""
    client = _get_im_client()
    try:
        res = client.im.files.delete(upload_id)
        if not res.get("ok"):
            click.echo(f"Error: {res.get('error')}", err=True)
            sys.exit(1)
        click.echo(f"Deleted upload {upload_id}.")
    finally:
        client.close()


@im_files.command("types")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def files_types(as_json):
    """List allowed MIME types."""
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
        click.echo(f"Allowed MIME types ({len(types_list)}):")
        for t in types_list:
            click.echo(f"  {t}")
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
    """Transaction history."""
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
        for t in txns:
            click.echo(f"{t.get('createdAt', '')}  {t.get('type', '')}  {t.get('amount', '')}  {t.get('description', '')}")
    finally:
        client.close()


# ============================================================================
# prismer context (subgroup)
# ============================================================================

@cli.group("context")
def context():
    """Context API commands."""
    pass


@context.command("load")
@click.argument("url")
@click.option("-f", "--format", "fmt", default="hqcc", help="Return format: hqcc, raw, both")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_load(url, fmt, as_json):
    """Load URL content."""
    client = _get_api_client()
    try:
        return_config = {"format": fmt}
        res = client.load(url, return_config=return_config)
        d = res.model_dump(by_alias=True, exclude_none=True)
        if as_json:
            click.echo(json.dumps(d, indent=2, default=str))
            return
        if not res.success:
            msg = res.error.message if res.error else "Load failed"
            click.echo(f"Error: {msg}", err=True)
            sys.exit(1)
        r = res.result
        click.echo(f"URL:     {r.url if r else url}")
        click.echo(f"Status:  {'cached' if r and r.cached else 'loaded'}")
        if r and r.hqcc:
            click.echo(f"\n--- HQCC ---\n{r.hqcc[:2000]}")
        if r and r.raw:
            click.echo(f"\n--- Raw ---\n{r.raw[:2000]}")
    finally:
        client.close()


@context.command("search")
@click.argument("query")
@click.option("-k", "--top-k", default=5, help="Number of results")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_search(query, top_k, as_json):
    """Search cached content."""
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


@context.command("save")
@click.argument("url")
@click.argument("hqcc")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def context_save(url, hqcc, as_json):
    """Save content to cache."""
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
        click.echo("Content saved.")
    finally:
        client.close()


# ============================================================================
# prismer parse (subgroup)
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
    """Parse a document."""
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
            click.echo(f"\nCheck progress: prismer parse status {res.task_id}")
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
# evolve commands
# ============================================================================

@cli.group("evolve")
def evolve():
    """Evolution engine commands."""
    pass

@evolve.command("analyze")
@click.option("-s", "--signals", required=True, help="Signals (JSON or comma-separated)")
@click.option("--json", "as_json", is_flag=True, help="JSON output")
def evolve_analyze(signals, as_json):
    """Analyze signals and get gene recommendation."""
    import json as _json
    client = _get_im_client()
    try:
        sig = _json.loads(signals)
    except Exception:
        sig = [s.strip() for s in signals.split(",")]
    res = client.im.evolution.analyze(signals=sig)
    if as_json:
        click.echo(_json.dumps(res, indent=2, ensure_ascii=False))
        return
    d = res.get("data", {})
    click.echo(f"Action:     {d.get('action')}")
    if d.get("gene"):
        g = d["gene"]
        click.echo(f"Gene:       {g.get('id')}\nTitle:      {g.get('title')}\nConfidence: {d.get('confidence')}")

@evolve.command("record")
@click.option("-g", "--gene", required=True, help="Gene ID")
@click.option("-o", "--outcome", required=True, help="success or failed")
@click.option("-s", "--signals", default="", help="Signals")
@click.option("--score", type=float, default=None, help="Score 0-1")
@click.option("--summary", default="", help="Summary")
@click.option("--json", "as_json", is_flag=True)
def evolve_record(gene, outcome, signals, score, summary, as_json):
    """Record gene execution outcome."""
    import json as _json
    client = _get_im_client()
    try:
        sig = _json.loads(signals) if signals else []
    except Exception:
        sig = [s.strip() for s in signals.split(",") if s.strip()]
    res = client.im.evolution.record(gene, sig, outcome, summary, score=score)
    if as_json:
        click.echo(_json.dumps(res, indent=2))
    else:
        click.echo(f"Recorded: {res.get('ok')}")

@evolve.command("genes")
@click.option("--json", "as_json", is_flag=True)
def evolve_genes(as_json):
    """List your genes."""
    import json as _json
    client = _get_im_client()
    res = client.im.evolution.list_genes()
    if as_json:
        click.echo(_json.dumps(res, indent=2))
        return
    genes = res.get("data", [])
    for g in genes:
        click.echo(f"  {g.get('id')}  {g.get('category')}  {g.get('title', '(untitled)')}  {g.get('visibility')}")
    click.echo(f"\n{len(genes)} genes")

@evolve.command("stats")
@click.option("--json", "as_json", is_flag=True)
def evolve_stats(as_json):
    """Show evolution statistics."""
    import json as _json
    client = _get_im_client()
    res = client.im.evolution.get_stats()
    if as_json:
        click.echo(_json.dumps(res, indent=2))
        return
    d = res.get("data", {})
    click.echo(f"Executions: {d.get('totalExecutions')}\nSuccess:    {(d.get('systemSuccessRate', 0) * 100):.1f}%")

@evolve.command("metrics")
@click.option("--json", "as_json", is_flag=True)
def evolve_metrics(as_json):
    """Show A/B experiment metrics."""
    import json as _json
    client = _get_im_client()
    res = client.im.evolution.get_metrics()
    if as_json:
        click.echo(_json.dumps(res, indent=2))
        return
    d = res.get("data", {})
    click.echo(f"Verdict: {d.get('verdict')}")


# ============================================================================
# Entry point
# ============================================================================

def main():
    cli()


if __name__ == "__main__":
    main()
