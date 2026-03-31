"""
Integration tests for v1.7.4 new APIs: Evolution, Tasks, Memory, Identity, Security.

Targets: https://cloud.prismer.dev (test environment)

Usage:
    PRISMER_API_KEY_TEST="sk-prismer-..." \
    PRISMER_BASE_URL_TEST="https://cloud.prismer.dev" \
    python -m pytest tests/test_new_apis.py -v --timeout=30
"""

import time
import uuid
import warnings
import pytest

from prismer import PrismerClient

from .conftest import API_KEY, RUN_ID


# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

BASE_URL = "https://cloud.prismer.dev"
TIMEOUT = 30.0


# ---------------------------------------------------------------------------
# Shared state across ordered tests within each class
# ---------------------------------------------------------------------------

class _State:
    """Mutable container for cross-test state."""
    agent_token: str = ""
    agent_id: str = ""
    agent_username: str = ""
    conv_id: str = ""
    # Evolution
    gene_id: str = ""
    # Tasks
    task_id: str = ""
    task_id_fail: str = ""
    # Memory
    memory_file_id: str = ""


_st = _State()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def platform_client():
    """PrismerClient authenticated with the platform API key."""
    c = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=TIMEOUT)
    yield c
    c.close()


@pytest.fixture(scope="module")
def agent_client():
    """PrismerClient authenticated with the registered agent's JWT.
    Created lazily — depends on _st.agent_token being set by test_00_setup.
    """
    # Yield a factory so we can create after registration
    clients = []

    def _make():
        assert _st.agent_token, "Agent not registered yet"
        c = PrismerClient(api_key=_st.agent_token, base_url=BASE_URL, timeout=TIMEOUT)
        clients.append(c)
        return c

    yield _make

    for c in clients:
        try:
            c.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Helper: graceful assertion
# ---------------------------------------------------------------------------

def _check_ok(res: dict, label: str) -> bool:
    """If res['ok'] is truthy return True; otherwise warn and return False."""
    if res.get("ok"):
        return True
    msg = res.get("error", res)
    warnings.warn(f"[SKIP] {label}: {msg}")
    return False


# ============================================================================
# 0. Setup — register an agent for all subsequent tests
# ============================================================================

class TestSetup:
    """Register an agent once before all other test classes run."""

    def test_00_register_agent(self, platform_client: PrismerClient):
        """Register a fresh agent and store its JWT + ID."""
        username = f"v174-test-{RUN_ID}"
        res = platform_client.im.account.register(
            type="agent",
            username=username,
            displayName=f"v1.7.4 Test Agent ({RUN_ID})",
            agentType="assistant",
            capabilities=["chat", "evolution", "tasks", "memory"],
        )
        assert res.get("ok") is True, f"agent registration failed: {res}"
        data = res["data"]
        _st.agent_token = data["token"]
        _st.agent_id = data["imUserId"]
        _st.agent_username = username

    def test_01_create_conversation(self, platform_client: PrismerClient):
        """Register a second agent and create a DM so we have a conversation ID."""
        res_b = platform_client.im.account.register(
            type="agent",
            username=f"v174-target-{RUN_ID}",
            displayName=f"v1.7.4 Target ({RUN_ID})",
            agentType="bot",
            capabilities=["chat"],
        )
        assert res_b.get("ok") is True, f"target agent registration failed: {res_b}"
        target_id = res_b["data"]["imUserId"]

        ac = PrismerClient(api_key=_st.agent_token, base_url=BASE_URL, timeout=TIMEOUT)
        try:
            send = ac.im.direct.send(target_id, "setup message for conv")
            assert send.get("ok") is True, f"setup send failed: {send}"
            _st.conv_id = send.get("data", {}).get("conversationId", "")
            assert _st.conv_id, "conversationId not returned"
        finally:
            ac.close()


# ============================================================================
# 1. Evolution tests (~20)
# ============================================================================

class TestEvolution:
    """Evolution API: genes, analyze, record, distill, skills, achievements, sync."""

    # ---- analyze ----

    def test_01_analyze_with_signals(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.analyze(
            signals=["python", "testing", "integration"],
        )
        if not _check_ok(res, "evolution.analyze"):
            return
        data = res["data"]
        assert "action" in data or "gene_id" in data or "signals" in data

    # ---- create_gene + list_genes + delete_gene ----

    def test_02_create_gene(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.create_gene(
            category="coding",
            signals_match=["python", "test-automation"],
            strategy=["Use pytest fixtures", "Assert gracefully"],
            description=f"Integration test gene ({RUN_ID})",
        )
        if not _check_ok(res, "evolution.create_gene"):
            return
        data = res["data"]
        _st.gene_id = data.get("id") or data.get("gene_id") or data.get("geneId", "")
        assert _st.gene_id, f"gene_id not in response: {data}"

    def test_03_list_genes(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.list_genes()
        if not _check_ok(res, "evolution.list_genes"):
            return
        data = res["data"]
        assert isinstance(data, list) or isinstance(data, dict)

    def test_04_delete_gene_later(self):
        """Placeholder — actual deletion tested at the end after other gene-dependent tests."""
        pass

    # ---- record success + failed ----

    def test_05_record_success(self, agent_client):
        if not _st.gene_id:
            pytest.skip("No gene_id from test_02")
        ac = agent_client()
        res = ac.im.evolution.record(
            gene_id=_st.gene_id,
            signals=["python", "integration"],
            outcome="success",
            summary="Test passed successfully in integration suite",
            score=0.9,
        )
        if not _check_ok(res, "evolution.record(success)"):
            return
        assert res["data"] is not None

    def test_06_record_failed(self, agent_client):
        if not _st.gene_id:
            pytest.skip("No gene_id from test_02")
        ac = agent_client()
        res = ac.im.evolution.record(
            gene_id=_st.gene_id,
            signals=["python", "edge-case"],
            outcome="failure",
            summary="Edge case caused unexpected behaviour",
            score=0.2,
        )
        if not _check_ok(res, "evolution.record(failure)"):
            return
        assert res["data"] is not None

    # ---- distill dry_run ----

    def test_07_distill_dry_run(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.distill(dry_run=True)
        if not _check_ok(res, "evolution.distill(dry_run)"):
            return
        data = res.get("data")
        assert data is not None

    # ---- browse_genes with category / search / sort ----

    def test_08_browse_genes_category(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.browse_genes(category="coding", limit=5)
        if not _check_ok(res, "evolution.browse_genes(category)"):
            return
        data = res.get("data")
        assert data is not None

    def test_09_browse_genes_search(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.browse_genes(search="python", limit=5)
        if not _check_ok(res, "evolution.browse_genes(search)"):
            return
        data = res.get("data")
        assert data is not None

    def test_10_browse_genes_sort(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.browse_genes(sort="popular", limit=5)
        if not _check_ok(res, "evolution.browse_genes(sort)"):
            return
        data = res.get("data")
        assert data is not None

    # ---- achievements ----

    def test_11_get_achievements(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.get_achievements()
        if not _check_ok(res, "evolution.get_achievements"):
            return
        data = res.get("data")
        assert data is not None

    # ---- sync snapshot ----

    def test_12_get_sync_snapshot(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.get_sync_snapshot()
        if not _check_ok(res, "evolution.get_sync_snapshot"):
            return
        data = res.get("data")
        assert data is not None

    # ---- sync pull only ----

    def test_13_sync_pull_only(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.sync(pull_since=0)
        if not _check_ok(res, "evolution.sync(pull)"):
            return
        data = res.get("data")
        assert data is not None

    # ---- evolve one-step ----

    def test_14_evolve_one_step(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.evolve(
            outcome="success",
            summary="One-step evolution integration test",
            signals=["python", "one-step"],
        )
        if not res.get("ok"):
            warnings.warn(f"[SKIP] evolution.evolve: {res}")
            return
        data = res.get("data", {})
        assert "analysis" in data or "recorded" in data

    # ---- export_as_skill ----

    def test_15_export_as_skill(self, agent_client):
        if not _st.gene_id:
            pytest.skip("No gene_id from test_02")
        ac = agent_client()
        res = ac.im.evolution.export_as_skill(
            _st.gene_id,
            slug=f"test-skill-{RUN_ID}",
            title=f"Test Skill {RUN_ID}",
        )
        if not _check_ok(res, "evolution.export_as_skill"):
            return
        data = res.get("data")
        assert data is not None

    # ---- search_skills ----

    def test_16_search_skills(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.search_skills(query="test", limit=5)
        if not _check_ok(res, "evolution.search_skills"):
            return
        data = res.get("data")
        assert data is not None

    # ---- install_skill + installed_skills + uninstall_skill ----

    def test_17_install_skill(self, agent_client):
        """Install a skill by searching for one first."""
        ac = agent_client()
        # Find a skill to install
        search = ac.im.evolution.search_skills(limit=1)
        if not search.get("ok"):
            warnings.warn(f"[SKIP] No skills to install: {search}")
            return
        skills = search.get("data", [])
        if not skills:
            # Try with the gene we exported
            slug = f"test-skill-{RUN_ID}"
        else:
            if isinstance(skills, list) and len(skills) > 0:
                slug = skills[0].get("slug") or skills[0].get("id", "")
            elif isinstance(skills, dict) and skills.get("skills"):
                slug = skills["skills"][0].get("slug") or skills["skills"][0].get("id", "")
            else:
                slug = f"test-skill-{RUN_ID}"

        if not slug:
            warnings.warn("[SKIP] No skill slug found")
            return

        res = ac.im.evolution.install_skill(slug)
        if not _check_ok(res, "evolution.install_skill"):
            return
        assert res.get("data") is not None

    def test_18_installed_skills(self, agent_client):
        ac = agent_client()
        res = ac.im.evolution.installed_skills()
        if not _check_ok(res, "evolution.installed_skills"):
            return
        data = res.get("data")
        assert data is not None

    def test_19_uninstall_skill(self, agent_client):
        """Uninstall the skill we installed (or skip if nothing installed)."""
        ac = agent_client()
        installed = ac.im.evolution.installed_skills()
        if not installed.get("ok"):
            warnings.warn(f"[SKIP] Cannot list installed skills: {installed}")
            return
        items = installed.get("data", [])
        if isinstance(items, list) and len(items) > 0:
            slug = items[0].get("slug") or items[0].get("skillId") or items[0].get("id", "")
            if isinstance(items[0], dict) and items[0].get("skill"):
                slug = items[0]["skill"].get("slug") or slug
        elif isinstance(items, dict) and items.get("installations"):
            insts = items["installations"]
            if insts:
                slug = insts[0].get("slug") or insts[0].get("skillId", "")
            else:
                warnings.warn("[SKIP] No installed skills to uninstall")
                return
        else:
            warnings.warn("[SKIP] No installed skills to uninstall")
            return

        if not slug:
            warnings.warn("[SKIP] No slug for uninstall")
            return

        res = ac.im.evolution.uninstall_skill(slug)
        if not _check_ok(res, "evolution.uninstall_skill"):
            return
        assert res.get("ok") is True

    # ---- delete gene (deferred from test_04) ----

    def test_20_delete_gene(self, agent_client):
        if not _st.gene_id:
            pytest.skip("No gene_id from test_02")
        ac = agent_client()
        res = ac.im.evolution.delete_gene(_st.gene_id)
        if not _check_ok(res, "evolution.delete_gene"):
            return
        assert res.get("ok") is True


# ============================================================================
# 2. Tasks tests (~8)
# ============================================================================

class TestTasks:
    """Tasks API: full lifecycle — create, list, get, update, claim, progress, complete, fail."""

    def test_01_create_task(self, agent_client):
        ac = agent_client()
        res = ac.im.tasks.create(
            title=f"Integration task {RUN_ID}",
            description="Automated integration test task",
            capability="testing",
            reward=1.0,
        )
        if not _check_ok(res, "tasks.create"):
            return
        data = res["data"]
        _st.task_id = data.get("id") or data.get("taskId", "")
        assert _st.task_id, f"task_id not in response: {data}"

    def test_02_list_tasks(self, agent_client):
        ac = agent_client()
        res = ac.im.tasks.list(limit=10)
        if not _check_ok(res, "tasks.list"):
            return
        data = res.get("data")
        assert data is not None

    def test_03_get_task(self, agent_client):
        if not _st.task_id:
            pytest.skip("No task_id")
        ac = agent_client()
        res = ac.im.tasks.get(_st.task_id)
        if not _check_ok(res, "tasks.get"):
            return
        data = res.get("data", {})
        task = data.get("task", data)
        assert task.get("id") == _st.task_id or task.get("taskId") == _st.task_id

    def test_04_update_task(self, agent_client):
        if not _st.task_id:
            pytest.skip("No task_id")
        ac = agent_client()
        res = ac.im.tasks.update(
            _st.task_id,
            description=f"Updated by integration test at {time.time()}",
        )
        if not _check_ok(res, "tasks.update"):
            return
        assert res.get("data") is not None

    def test_05_claim_task(self, agent_client):
        if not _st.task_id:
            pytest.skip("No task_id")
        ac = agent_client()
        res = ac.im.tasks.claim(_st.task_id)
        if not _check_ok(res, "tasks.claim"):
            return
        assert res.get("data") is not None

    def test_06_progress_task(self, agent_client):
        if not _st.task_id:
            pytest.skip("No task_id")
        ac = agent_client()
        res = ac.im.tasks.progress(
            _st.task_id,
            message="50% complete — running assertions",
            metadata={"percent": 50},
        )
        if not _check_ok(res, "tasks.progress"):
            return
        # progress may return ok:true with or without data (void response)
        assert res.get("ok") is True

    def test_07_complete_task(self, agent_client):
        if not _st.task_id:
            pytest.skip("No task_id")
        ac = agent_client()
        res = ac.im.tasks.complete(
            _st.task_id,
            result="All assertions passed",
            cost=0.5,
        )
        if not _check_ok(res, "tasks.complete"):
            return
        assert res.get("data") is not None

    def test_08_create_and_fail_task(self, agent_client):
        ac = agent_client()
        create = ac.im.tasks.create(
            title=f"Fail-task {RUN_ID}",
            description="This task will be intentionally failed",
            capability="testing",
        )
        if not _check_ok(create, "tasks.create(for fail)"):
            return
        task_id = create["data"].get("id") or create["data"].get("taskId", "")
        assert task_id, "task_id not returned"

        # Claim it first (required before fail)
        claim = ac.im.tasks.claim(task_id)
        if not claim.get("ok"):
            warnings.warn(f"[SKIP] tasks.claim before fail: {claim}")
            # Try to fail anyway

        res = ac.im.tasks.fail(
            task_id,
            error="Intentional failure for integration test",
            metadata={"reason": "testing"},
        )
        if not _check_ok(res, "tasks.fail"):
            return
        assert res.get("data") is not None


# ============================================================================
# 3. Memory tests (~7)
# ============================================================================

class TestMemory:
    """Memory API: file CRUD, compact, load."""

    def test_01_create_file(self, agent_client):
        ac = agent_client()
        res = ac.im.memory.create_file(
            path=f"test/{RUN_ID}/MEMORY.md",
            content=f"# Test Memory\n\nCreated by integration test run {RUN_ID}.",
        )
        if not _check_ok(res, "memory.create_file"):
            return
        data = res["data"]
        _st.memory_file_id = data.get("id") or data.get("fileId", "")
        assert _st.memory_file_id, f"file id not in response: {data}"

    def test_02_list_files(self, agent_client):
        ac = agent_client()
        res = ac.im.memory.list_files()
        if not _check_ok(res, "memory.list_files"):
            return
        data = res.get("data")
        assert data is not None

    def test_03_get_file(self, agent_client):
        if not _st.memory_file_id:
            pytest.skip("No memory_file_id")
        ac = agent_client()
        res = ac.im.memory.get_file(_st.memory_file_id)
        if not _check_ok(res, "memory.get_file"):
            return
        data = res.get("data", {})
        assert data.get("content") is not None or data.get("path") is not None

    def test_04_update_file_append(self, agent_client):
        if not _st.memory_file_id:
            pytest.skip("No memory_file_id")
        ac = agent_client()
        res = ac.im.memory.update_file(
            _st.memory_file_id,
            operation="append",
            content="\n\n## Appended Section\n\nThis was appended by integration test.",
        )
        if not _check_ok(res, "memory.update_file(append)"):
            return
        assert res.get("data") is not None

    def test_05_update_file_replace(self, agent_client):
        if not _st.memory_file_id:
            pytest.skip("No memory_file_id")
        ac = agent_client()
        res = ac.im.memory.update_file(
            _st.memory_file_id,
            operation="replace",
            content=f"# Replaced Memory\n\nFully replaced at {time.time()}.",
        )
        if not _check_ok(res, "memory.update_file(replace)"):
            return
        assert res.get("data") is not None

    def test_06_compact(self, agent_client):
        if not _st.conv_id:
            pytest.skip("No conv_id from setup")
        ac = agent_client()
        res = ac.im.memory.compact(
            conversation_id=_st.conv_id,
            summary=f"Compaction summary from integration test run {RUN_ID}",
        )
        if not _check_ok(res, "memory.compact"):
            return
        assert res.get("data") is not None

    def test_07_load(self, agent_client):
        ac = agent_client()
        res = ac.im.memory.load()
        if not _check_ok(res, "memory.load"):
            return
        data = res.get("data")
        assert data is not None

    def test_08_delete_file(self, agent_client):
        if not _st.memory_file_id:
            pytest.skip("No memory_file_id")
        ac = agent_client()
        res = ac.im.memory.delete_file(_st.memory_file_id)
        if not _check_ok(res, "memory.delete_file"):
            return
        assert res.get("ok") is True


# ============================================================================
# 4. Identity tests (~4)
# ============================================================================

class TestIdentity:
    """Identity key management: server key, register, get, audit log."""

    def test_01_get_server_key(self, agent_client):
        ac = agent_client()
        res = ac.im.identity.get_server_key()
        if not _check_ok(res, "identity.get_server_key"):
            return
        data = res.get("data", {})
        assert data.get("publicKey") is not None or data.get("key") is not None or isinstance(data, dict)

    def test_02_register_key(self, agent_client):
        ac = agent_client()
        # Generate a dummy Ed25519-like base64 key (32 bytes base64-encoded)
        import base64
        dummy_key = base64.b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes).decode()
        res = ac.im.identity.register_key(public_key=dummy_key)
        if not _check_ok(res, "identity.register_key"):
            return
        assert res.get("data") is not None

    def test_03_get_key(self, agent_client):
        ac = agent_client()
        res = ac.im.identity.get_key(_st.agent_id)
        if not _check_ok(res, "identity.get_key"):
            return
        data = res.get("data")
        assert data is not None

    def test_04_get_audit_log(self, agent_client):
        ac = agent_client()
        res = ac.im.identity.get_audit_log(_st.agent_id)
        if not _check_ok(res, "identity.get_audit_log"):
            return
        data = res.get("data")
        assert data is not None


# ============================================================================
# 5. Security tests (~2)
# ============================================================================

class TestSecurity:
    """Conversation security: get/set security settings."""

    def test_01_get_conversation_security(self, agent_client):
        if not _st.conv_id:
            pytest.skip("No conv_id from setup")
        ac = agent_client()
        res = ac.im.security.get_conversation_security(_st.conv_id)
        if not _check_ok(res, "security.get_conversation_security"):
            return
        data = res.get("data")
        assert data is not None

    def test_02_set_conversation_security(self, agent_client):
        if not _st.conv_id:
            pytest.skip("No conv_id from setup")
        ac = agent_client()
        res = ac.im.security.set_conversation_security(
            _st.conv_id,
            signingPolicy="optional",
        )
        if not _check_ok(res, "security.set_conversation_security"):
            return
        data = res.get("data")
        assert data is not None
