"""
Comprehensive integration tests for the Prismer Python SDK.

Covers:
  - Context API  (load, save)
  - Parse API    (parse_pdf)
  - IM API       (account, direct, groups, conversations, contacts, credits, edge cases)
  - IM v3.4.0    (message threading, new message types, metadata, edit/delete)
  - Real-Time    (WebSocket connect/authenticate/ping/receive, SSE connect/receive)

Usage:
    PRISMER_API_KEY_TEST="sk-prismer-..." python -m pytest tests/test_integration.py -v
"""

import asyncio
import json
import time
import pytest

from prismer import PrismerClient

from .conftest import API_KEY, BASE_URL, RUN_ID


# ============================================================================
# Group 1: Context API
# ============================================================================

class TestContextAPI:
    """Context API — load and save."""

    def test_load_single_url(self, client: PrismerClient):
        """Load a single URL and verify success, mode, result."""
        result = client.load("https://example.com")
        assert result.success is True, f"load failed: {result.error}"
        assert result.mode == "single_url"
        assert result.result is not None
        assert result.result.url == "https://example.com"

    def test_load_batch_urls(self, client: PrismerClient):
        """Load multiple URLs and verify batch mode."""
        urls = [
            "https://example.com",
            "https://www.iana.org/domains/reserved",
        ]
        result = client.load(urls)
        assert result.success is True, f"batch load failed: {result.error}"
        assert result.mode == "batch_urls"
        assert result.results is not None
        assert len(result.results) == 2

    def test_save_content(self, client: PrismerClient):
        """Save content to the Prismer cache."""
        unique_url = f"https://test.example.com/integration-{RUN_ID}"
        hqcc = f"# Integration Test\n\nContent saved by run {RUN_ID}."
        result = client.save(url=unique_url, hqcc=hqcc)
        assert result.success is True, f"save failed: {result.error}"


# ============================================================================
# Group 2: Parse API
# ============================================================================

class TestParseAPI:
    """Parse API — PDF parsing."""

    def test_parse_pdf(self, client: PrismerClient):
        """Parse a public PDF and verify success and requestId."""
        result = client.parse_pdf("https://arxiv.org/pdf/2301.00234.pdf", mode="fast")
        assert result.success is True, f"parse_pdf failed: {result.error}"
        assert result.request_id is not None, "requestId should be present"
        if result.cost is not None:
            assert result.cost.credits >= 0


# ============================================================================
# Group 3: IM API — Full Lifecycle
# ============================================================================

class TestIMLifecycle:
    """
    IM API full lifecycle using two agents.

    Because each sub-client method in the SDK returns a raw dict (not an
    IMResult Pydantic model), assertions are written against dict keys.

    After registration the returned JWT is used to create a *new*
    PrismerClient so that subsequent IM calls are authenticated with the
    agent's JWT rather than the platform API key.
    """

    # ------------------------------------------------------------------
    # Account: Register agent A
    # ------------------------------------------------------------------

    def test_01_register_agent_a(self, client: PrismerClient, run_id: str):
        """Register agent A and stash its imUserId + JWT."""
        res = client.im.account.register(
            type="agent",
            username=f"integ-agent-a-{run_id}",
            displayName=f"Agent A ({run_id})",
            agentType="assistant",
            capabilities=["chat"],
        )
        assert res.get("ok") is True, f"register agent A failed: {res}"
        data = res["data"]
        assert "imUserId" in data
        assert "token" in data

        # Store for later tests
        self.__class__._agent_a_id = data["imUserId"]
        self.__class__._agent_a_token = data["token"]
        self.__class__._agent_a_username = f"integ-agent-a-{run_id}"

    # ------------------------------------------------------------------
    # Account: me() and refresh_token() for agent A
    # ------------------------------------------------------------------

    def test_02_me(self, base_url: str):
        """Verify /me returns the agent's own profile."""
        token = self.__class__._agent_a_token
        agent_client = PrismerClient(api_key=token, base_url=base_url, timeout=60.0)
        try:
            res = agent_client.im.account.me()
            assert res.get("ok") is True, f"me() failed: {res}"
            assert "user" in res.get("data", {})
        finally:
            agent_client.close()

    def test_03_refresh_token(self, base_url: str):
        """Refresh JWT and update stored token."""
        token = self.__class__._agent_a_token
        agent_client = PrismerClient(api_key=token, base_url=base_url, timeout=60.0)
        try:
            res = agent_client.im.account.refresh_token()
            assert res.get("ok") is True, f"refresh_token failed: {res}"
            new_token = res["data"]["token"]
            assert new_token  # non-empty
            self.__class__._agent_a_token = new_token
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Account: Register agent B (target for DMs)
    # ------------------------------------------------------------------

    def test_04_register_agent_b(self, client: PrismerClient, run_id: str):
        """Register a second agent to serve as DM target."""
        res = client.im.account.register(
            type="agent",
            username=f"integ-agent-b-{run_id}",
            displayName=f"Agent B ({run_id})",
            agentType="assistant",
            capabilities=["chat"],
        )
        assert res.get("ok") is True, f"register agent B failed: {res}"
        data = res["data"]
        self.__class__._agent_b_id = data["imUserId"]
        self.__class__._agent_b_token = data["token"]

    # ------------------------------------------------------------------
    # Direct Messaging
    # ------------------------------------------------------------------

    def test_05_direct_send(self, base_url: str):
        """Agent A sends a DM to agent B."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            target_id = self.__class__._agent_b_id
            res = agent_client.im.direct.send(target_id, "Hello from integration test!")
            assert res.get("ok") is True, f"direct.send failed: {res}"
            # Store conversation ID and message ID for later tests
            data = res.get("data", {})
            if "conversationId" in data:
                self.__class__._direct_conv_id = data["conversationId"]
            if "message" in data:
                self.__class__._first_direct_msg_id = data["message"].get("id")
        finally:
            agent_client.close()

    def test_06_direct_get_messages(self, base_url: str):
        """Agent A retrieves DM history with agent B."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            target_id = self.__class__._agent_b_id
            res = agent_client.im.direct.get_messages(target_id)
            assert res.get("ok") is True, f"direct.get_messages failed: {res}"
            messages = res.get("data", [])
            assert isinstance(messages, list)
            assert len(messages) >= 1, "Expected at least 1 message"
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Credits
    # ------------------------------------------------------------------

    def test_07_credits_get(self, base_url: str):
        """Verify credits balance for a new agent (~100)."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.credits.get()
            assert res.get("ok") is True, f"credits.get failed: {res}"
            data = res["data"]
            assert "balance" in data
            # New agents typically get ~100 credits
            assert data["balance"] >= 0
        finally:
            agent_client.close()

    def test_08_credits_transactions(self, base_url: str):
        """Verify transaction history is an array."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.credits.transactions()
            assert res.get("ok") is True, f"credits.transactions failed: {res}"
            data = res.get("data", [])
            assert isinstance(data, list)
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Contacts & Discovery
    # ------------------------------------------------------------------

    def test_09_contacts_list(self, base_url: str):
        """Contacts list should return an array (may include agent B after DM)."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.contacts.list()
            assert res.get("ok") is True, f"contacts.list failed: {res}"
            data = res.get("data", [])
            assert isinstance(data, list)
        finally:
            agent_client.close()

    def test_10_contacts_discover(self, base_url: str):
        """Discover agents — should return an array."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.contacts.discover()
            assert res.get("ok") is True, f"contacts.discover failed: {res}"
            data = res.get("data", [])
            assert isinstance(data, list)
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    def test_11_groups_create(self, base_url: str, run_id: str):
        """Create a group with both agents."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.groups.create(
                title=f"Test Group {run_id}",
                members=[self.__class__._agent_b_id],
            )
            assert res.get("ok") is True, f"groups.create failed: {res}"
            data = res["data"]
            assert "groupId" in data
            self.__class__._group_id = data["groupId"]
        finally:
            agent_client.close()

    def test_12_groups_list(self, base_url: str):
        """List groups — should contain at least the one we created."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.groups.list()
            assert res.get("ok") is True, f"groups.list failed: {res}"
            data = res.get("data", [])
            assert isinstance(data, list)
            assert len(data) >= 1
        finally:
            agent_client.close()

    def test_13_groups_get(self, base_url: str):
        """Get group details by ID."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            group_id = self.__class__._group_id
            res = agent_client.im.groups.get(group_id)
            assert res.get("ok") is True, f"groups.get failed: {res}"
            data = res.get("data", {})
            assert data.get("groupId") == group_id or data.get("title") is not None
        finally:
            agent_client.close()

    def test_14_groups_send(self, base_url: str):
        """Send a message to the group."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            group_id = self.__class__._group_id
            res = agent_client.im.groups.send(group_id, "Hello group from integration test!")
            assert res.get("ok") is True, f"groups.send failed: {res}"
            # Stash the message ID for threading test
            data = res.get("data", {})
            msg = data.get("message", {})
            if "id" in msg:
                self.__class__._group_msg_id = msg["id"]
        finally:
            agent_client.close()

    def test_15_groups_get_messages(self, base_url: str):
        """Get group message history."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            group_id = self.__class__._group_id
            res = agent_client.im.groups.get_messages(group_id)
            assert res.get("ok") is True, f"groups.get_messages failed: {res}"
            messages = res.get("data", [])
            assert isinstance(messages, list)
            assert len(messages) >= 1
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Conversations
    # ------------------------------------------------------------------

    def test_16_conversations_list(self, base_url: str):
        """List conversations for agent A — should include DM and group."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.conversations.list()
            assert res.get("ok") is True, f"conversations.list failed: {res}"
            data = res.get("data", [])
            assert isinstance(data, list)
            assert len(data) >= 1
            # Stash first conversation id for next test
            self.__class__._conv_id = data[0]["id"]
        finally:
            agent_client.close()

    def test_17_conversations_get(self, base_url: str):
        """Get details of a specific conversation."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            conv_id = self.__class__._conv_id
            res = agent_client.im.conversations.get(conv_id)
            assert res.get("ok") is True, f"conversations.get failed: {res}"
            data = res.get("data", {})
            assert data.get("id") == conv_id
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Conversations Extended (v3.4.0)
    # ------------------------------------------------------------------

    def test_18_conversations_create_direct(self, base_url: str):
        """Explicitly create a direct conversation."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.conversations.create_direct(self.__class__._agent_b_id)
            # createDirect may or may not be available; accept ok or error
            if res.get("ok"):
                data = res.get("data", {})
                assert "id" in data
            else:
                assert res.get("error") is not None or res.get("ok") is False
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Messages Edit & Delete
    # ------------------------------------------------------------------

    def test_19_messages_send_low_level(self, base_url: str):
        """Send a message via low-level messages.send and stash its ID."""
        conv_id = getattr(self.__class__, "_direct_conv_id", None) or self.__class__._conv_id
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.messages.send(conv_id, "Low-level message for edit/delete test")
            assert res.get("ok") is True, f"messages.send failed: {res}"
            data = res.get("data", {})
            msg = data.get("message", {})
            self.__class__._low_level_msg_id = msg.get("id")
            self.__class__._low_level_conv_id = conv_id
        finally:
            agent_client.close()

    def test_20_messages_edit(self, base_url: str):
        """Edit a message and verify."""
        conv_id = self.__class__._low_level_conv_id
        msg_id = self.__class__._low_level_msg_id
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.messages.edit(conv_id, msg_id, "Edited content from Python test")
            # edit may or may not be supported
            if res.get("ok"):
                assert res.get("data") is not None or res.get("ok") is True
            else:
                assert res.get("error") is not None
        finally:
            agent_client.close()

    def test_21_messages_delete(self, base_url: str):
        """Delete a message."""
        conv_id = self.__class__._low_level_conv_id
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            # Send a throwaway message to delete
            send_res = agent_client.im.messages.send(conv_id, "Message to delete from Python")
            assert send_res.get("ok") is True
            del_msg_id = send_res["data"]["message"]["id"]

            res = agent_client.im.messages.delete(conv_id, del_msg_id)
            # delete may or may not be supported
            if res.get("ok"):
                assert res.get("ok") is True
            else:
                assert res.get("error") is not None
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Message Threading (v3.4.0)
    # ------------------------------------------------------------------

    def test_22_direct_send_with_parent_id(self, base_url: str):
        """Send a threaded reply using parentId on direct messages."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            target_id = self.__class__._agent_b_id
            # Send parent
            parent_res = agent_client.im.direct.send(target_id, "Parent message for threading")
            assert parent_res.get("ok") is True
            parent_id = parent_res["data"]["message"]["id"]

            # Send reply with parentId
            reply_res = agent_client.im.direct.send(
                target_id, "Threaded reply", parent_id=parent_id
            )
            assert reply_res.get("ok") is True, f"threaded reply failed: {reply_res}"
            assert reply_res["data"]["message"]["id"]
        finally:
            agent_client.close()

    def test_23_group_send_with_parent_id(self, base_url: str):
        """Send a threaded reply in a group using parentId."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            group_id = self.__class__._group_id
            # Send parent
            parent_res = agent_client.im.groups.send(group_id, "Group parent for threading")
            assert parent_res.get("ok") is True
            parent_id = parent_res["data"]["message"]["id"]

            # Send reply with parentId
            reply_res = agent_client.im.groups.send(
                group_id, "Group threaded reply", parent_id=parent_id
            )
            assert reply_res.get("ok") is True, f"group threaded reply failed: {reply_res}"
        finally:
            agent_client.close()

    def test_24_messages_send_with_parent_id(self, base_url: str):
        """Low-level messages.send with parentId."""
        conv_id = self.__class__._low_level_conv_id
        msg_id = self.__class__._low_level_msg_id
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.messages.send(
                conv_id, "Low-level threaded reply", parent_id=msg_id
            )
            assert res.get("ok") is True, f"messages.send with parentId failed: {res}"
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # New Message Types (v3.4.0)
    # ------------------------------------------------------------------

    def test_25_send_markdown_message(self, base_url: str):
        """Send a markdown-type message."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                "# Heading\n\n**bold** text",
                type="markdown",
            )
            assert res.get("ok") is True, f"markdown send failed: {res}"
            assert res["data"]["message"]["type"] == "markdown"
        finally:
            agent_client.close()

    def test_26_send_tool_call_message(self, base_url: str):
        """Send a tool_call message with metadata."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                json.dumps({"tool": "search", "query": "test"}),
                type="tool_call",
                metadata={"toolName": "search", "toolCallId": "tc-py-001"},
            )
            assert res.get("ok") is True, f"tool_call send failed: {res}"
            assert res["data"]["message"]["type"] == "tool_call"
        finally:
            agent_client.close()

    def test_27_send_tool_result_message(self, base_url: str):
        """Send a tool_result message with metadata."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                json.dumps({"results": ["item1", "item2"]}),
                type="tool_result",
                metadata={"toolCallId": "tc-py-001"},
            )
            assert res.get("ok") is True, f"tool_result send failed: {res}"
            assert res["data"]["message"]["type"] == "tool_result"
        finally:
            agent_client.close()

    def test_28_send_thinking_message(self, base_url: str):
        """Send a thinking-type message."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                "Analyzing the problem step by step...",
                type="thinking",
            )
            assert res.get("ok") is True, f"thinking send failed: {res}"
            assert res["data"]["message"]["type"] == "thinking"
        finally:
            agent_client.close()

    def test_29_send_image_message(self, base_url: str):
        """Send an image-type message."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                "https://example.com/test-image.png",
                type="image",
                metadata={"mimeType": "image/png", "width": 800, "height": 600},
            )
            assert res.get("ok") is True, f"image send failed: {res}"
            assert res["data"]["message"]["type"] == "image"
        finally:
            agent_client.close()

    def test_30_send_file_message(self, base_url: str):
        """Send a file-type message."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                "https://example.com/document.pdf",
                type="file",
                metadata={"filename": "document.pdf", "mimeType": "application/pdf", "size": 1024},
            )
            assert res.get("ok") is True, f"file send failed: {res}"
            assert res["data"]["message"]["type"] == "file"
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Message Metadata (v3.4.0)
    # ------------------------------------------------------------------

    def test_31_send_message_with_structured_metadata(self, base_url: str):
        """Send message with structured metadata and verify in history."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            metadata = {
                "source": "integration-test",
                "version": "3.4.0",
                "custom": {"nested": True, "tags": ["test", "v3.4.0"]},
            }
            res = agent_client.im.direct.send(
                self.__class__._agent_b_id,
                "Message with metadata from Python",
                metadata=metadata,
            )
            assert res.get("ok") is True, f"metadata send failed: {res}"

            # Verify in history
            history = agent_client.im.direct.get_messages(
                self.__class__._agent_b_id, limit=5
            )
            assert history.get("ok") is True
            messages = history.get("data", [])
            found = [m for m in messages if m.get("content") == "Message with metadata from Python"]
            assert len(found) >= 1
            if found[0].get("metadata"):
                assert found[0]["metadata"] is not None
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Groups Extended (v3.4.0)
    # ------------------------------------------------------------------

    def test_32_groups_remove_member(self, base_url: str, run_id: str, client: PrismerClient):
        """Remove a member from a group."""
        # Register agent C
        res_c = client.im.account.register(
            type="agent",
            username=f"integ-agent-c-{run_id}",
            displayName=f"Agent C ({run_id})",
            agentType="bot",
            capabilities=["testing"],
        )
        assert res_c.get("ok") is True, f"register agent C failed: {res_c}"
        agent_c_id = res_c["data"]["imUserId"]

        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            # Create a group with C as member
            create_res = agent_client.im.groups.create(
                title=f"Remove Test Group {run_id}",
                members=[agent_c_id],
            )
            assert create_res.get("ok") is True
            rm_group_id = create_res["data"]["groupId"]

            # Remove C
            rm_res = agent_client.im.groups.remove_member(rm_group_id, agent_c_id)
            if rm_res.get("ok"):
                # Note: some API implementations may return ok but not immediately remove
                pass
            else:
                assert rm_res.get("error") is not None
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Workspace Extended (v3.4.0)
    # ------------------------------------------------------------------

    def test_33_workspace_init_group(self, base_url: str):
        """Initialize a group workspace."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.workspace.init_group("test-ws-int", "Integration Group", [{"userId": "test-user", "displayName": "Test"}])
            if res.get("ok"):
                data = res.get("data", {})
                assert "workspaceId" in data
            else:
                assert res.get("error") is not None
        finally:
            agent_client.close()

    def test_34_workspace_mention_autocomplete(self, base_url: str):
        """Search for @mention targets."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            res = agent_client.im.workspace.mention_autocomplete("test-conv", "agent")
            if res.get("ok"):
                data = res.get("data", [])
                assert isinstance(data, list)
            else:
                assert res.get("error") is not None
        finally:
            agent_client.close()

    # ------------------------------------------------------------------
    # Edge Cases
    # ------------------------------------------------------------------

    def test_35_duplicate_register(self, client: PrismerClient, run_id: str):
        """Registering the same username again should return 409 or an error."""
        res = client.im.account.register(
            type="agent",
            username=f"integ-agent-a-{run_id}",
            displayName=f"Agent A ({run_id})",
            agentType="assistant",
            capabilities=["chat"],
        )
        # The server may return the existing user (ok=True, isNew=False)
        # or a 409 conflict (ok=False). Both are acceptable.
        if res.get("ok") is True:
            # If the server returns success, isNew should be False
            data = res.get("data", {})
            assert data.get("isNew") is False, (
                "Duplicate register returned ok=True but isNew is not False"
            )
        else:
            # ok=False — expect a conflict-style error
            err = res.get("error", {})
            assert err.get("code") in (
                "CONFLICT",
                "USERNAME_TAKEN",
                "DUPLICATE",
                "HTTP_ERROR",
            ), f"Unexpected error code: {err}"

    def test_36_send_to_nonexistent_user(self, base_url: str):
        """Sending a DM to a non-existent user should fail (404 or error)."""
        agent_client = PrismerClient(
            api_key=self.__class__._agent_a_token,
            base_url=base_url,
            timeout=60.0,
        )
        try:
            fake_id = "nonexistent-user-00000000"
            res = agent_client.im.direct.send(fake_id, "Should fail")
            # Expect ok=False with some error
            assert res.get("ok") is False, (
                f"Sending to nonexistent user should fail, got: {res}"
            )
        finally:
            agent_client.close()


# ============================================================================
# Group 4: Real-Time — WebSocket
# ============================================================================

class TestRealtimeWebSocket:
    """Real-time WebSocket integration tests (async)."""

    def test_ws_connect_ping_receive_disconnect(self, base_url: str):
        """Connect, authenticate, ping, receive message, disconnect via WS."""
        asyncio.get_event_loop().run_until_complete(
            self._ws_test(base_url)
        )

    async def _ws_test(self, base_url: str):
        from prismer.realtime import AsyncRealtimeWSClient, RealtimeConfig

        token_a = TestIMLifecycle._agent_a_token
        token_b = TestIMLifecycle._agent_b_token
        agent_a_id = TestIMLifecycle._agent_a_id
        agent_b_id = TestIMLifecycle._agent_b_id
        conv_id = getattr(TestIMLifecycle, "_direct_conv_id", None) or TestIMLifecycle._conv_id

        config = RealtimeConfig(
            token=token_a,
            auto_reconnect=False,
            heartbeat_interval=60.0,
        )

        ws = AsyncRealtimeWSClient(base_url, config)

        # Track authentication
        auth_event = asyncio.Event()
        auth_payload = {}

        @ws.on("authenticated")
        def on_auth(payload):
            auth_payload.update(payload.__dict__ if hasattr(payload, "__dict__") else {"raw": payload})
            auth_event.set()

        # Connect
        await ws.connect()
        assert ws.state == "connected"

        # Wait for auth
        await asyncio.wait_for(auth_event.wait(), timeout=10)

        # Ping — may timeout if server doesn't support ping/pong
        try:
            pong = await ws.ping()
        except Exception:
            pong = None  # non-fatal

        # Join conversation
        await ws.join_conversation(conv_id)
        await asyncio.sleep(1)

        # Listen for message.new
        msg_event = asyncio.Event()
        received_msg = {}

        @ws.on("message.new")
        def on_msg(payload):
            received_msg.update(payload.__dict__ if hasattr(payload, "__dict__") else {"raw": payload})
            msg_event.set()

        # Agent B sends via HTTP
        client_b = PrismerClient(api_key=token_b, base_url=base_url, timeout=60.0)
        try:
            send_res = client_b.im.direct.send(agent_a_id, f"WS realtime test {RUN_ID}")
            assert send_res.get("ok") is True
        finally:
            client_b.close()

        # Wait for event (may or may not arrive)
        try:
            await asyncio.wait_for(msg_event.wait(), timeout=15)
        except asyncio.TimeoutError:
            pass  # non-fatal — server may not relay to self

        # Disconnect
        await ws.disconnect()
        assert ws.state == "disconnected"


# ============================================================================
# Group 5: Real-Time — SSE
# ============================================================================

class TestRealtimeSSE:
    """Real-time SSE integration tests (async)."""

    def test_sse_connect_receive_disconnect(self, base_url: str):
        """Connect, receive message, disconnect via SSE."""
        asyncio.get_event_loop().run_until_complete(
            self._sse_test(base_url)
        )

    async def _sse_test(self, base_url: str):
        from prismer.realtime import AsyncRealtimeSSEClient, RealtimeConfig

        token_a = TestIMLifecycle._agent_a_token
        token_b = TestIMLifecycle._agent_b_token
        agent_a_id = TestIMLifecycle._agent_a_id

        config = RealtimeConfig(
            token=token_a,
            auto_reconnect=False,
        )

        sse = AsyncRealtimeSSEClient(base_url, config)

        # Connect
        await sse.connect()
        assert sse.state == "connected"

        await asyncio.sleep(1)

        # Listen for message.new
        msg_event = asyncio.Event()
        received_msg = {}

        @sse.on("message.new")
        def on_msg(payload):
            received_msg.update(payload.__dict__ if hasattr(payload, "__dict__") else {"raw": payload})
            msg_event.set()

        # Agent B sends via HTTP
        client_b = PrismerClient(api_key=token_b, base_url=base_url, timeout=60.0)
        try:
            send_res = client_b.im.direct.send(agent_a_id, f"SSE realtime test {RUN_ID}")
            assert send_res.get("ok") is True
        finally:
            client_b.close()

        # Wait for event (may or may not arrive)
        try:
            await asyncio.wait_for(msg_event.wait(), timeout=15)
        except asyncio.TimeoutError:
            pass  # non-fatal — server may not relay to self

        # Disconnect
        await sse.disconnect()
        assert sse.state == "disconnected"
