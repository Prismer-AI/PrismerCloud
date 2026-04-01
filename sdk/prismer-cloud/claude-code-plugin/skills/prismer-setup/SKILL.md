---
name: prismer-setup
description: Set up Prismer API key — opens browser, auto-registers, zero copy-paste
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Prismer Setup

## Step 1: Check existing config

```bash
cat ~/.prismer/config.toml 2>/dev/null | grep api_key | head -1 || echo "No config found"
```

If already configured and user doesn't want to reconfigure, stop here.

## Step 2: Run auto-setup

IMPORTANT: This command opens the browser and waits for the user to sign in. Set Bash timeout to 300000 (5 minutes):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --force
```

The script:
1. Starts a local callback server
2. Opens the browser to prismer.cloud/setup
3. User signs in or registers → key auto-created → redirected back to localhost
4. Key saved to `~/.prismer/config.toml`

**Wait for it to complete.** It will print "API key saved" when done.

## Step 3: After setup

Tell the user: "Setup complete! Run `/reload-plugins` to activate MCP tools."
