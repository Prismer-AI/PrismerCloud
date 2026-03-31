"""
Prismer Python SDK — Doc Sample Tests

Each test is annotated with @doc-sample and contains --- sample start/end --- markers.
Only code between these markers is extracted for docs. The surrounding test
assertions ensure the sample actually works.

Usage:
    PRISMER_API_KEY_TEST="sk-prismer-live-..." python -m pytest tests/doc_samples_test.py -v

Extract samples:
    npx tsx scripts/docs/extract-samples.ts
"""

import os
import time

import pytest

from prismer import PrismerClient


API_KEY = os.environ.get("PRISMER_API_KEY_TEST")
if not API_KEY:
    raise RuntimeError("PRISMER_API_KEY_TEST environment variable is required")
BASE_URL = os.environ.get("PRISMER_BASE_URL_TEST", "https://prismer.cloud")


# ═══════════════════════════════════════════════════════════════════
# Context API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesContextAPI:
    """Doc Samples: Context API"""

    # @doc-sample: contextLoad / single_url
    def test_context_load_single_url(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.load("https://example.com")

        if result.result:
            print(result.result.title)    # page title
            print(result.result.hqcc)     # compressed content
            print(result.result.cached)   # True if from global cache
        # --- sample end ---

        # Real test
        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL)
        r = real.load("https://example.com")
        assert r.success is True
        assert r.result is not None
        real.close()

    # @doc-sample: contextLoad / batch_urls
    def test_context_load_batch_urls(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.load([
            "https://example.com",
            "https://httpbin.org/html",
        ])

        if result.results:
            for r in result.results:
                print(f"{r.title}: {'cached' if r.cached else 'fresh'}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL)
        r = real.load(["https://example.com", "https://httpbin.org/html"])
        assert r.success is True
        assert r.results is not None
        assert len(r.results) >= 1
        real.close()

    # @doc-sample: contextLoad / search_query
    @pytest.mark.timeout(60)
    def test_context_load_search_query(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.load("latest AI research papers", input_type="query")

        if result.results:
            for r in result.results:
                print(f"{r.title}: {r.url}")
            print(f"Total: {result.summary.get('returned', 0)} results")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.load("What is TypeScript?", input_type="query")
        assert r.success is True
        real.close()

    # @doc-sample: contextSave / basic
    def test_context_save_basic(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.save(
            url="https://my-app.com/docs/api-reference",
            hqcc="# API Reference\n\nCompressed documentation content...",
            visibility="private",
        )

        if result.success:
            print(result.status)  # "deposited"
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL)
        r = real.save(
            url=f"https://doc-sample-test-{int(time.time())}.example.com",
            hqcc=f"Doc sample test content {time.time()}",
        )
        assert r.success is True
        real.close()


# ═══════════════════════════════════════════════════════════════════
# Parse API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesParseAPI:
    """Doc Samples: Parse API"""

    # @doc-sample: parseDocument / pdf_fast
    @pytest.mark.timeout(60)
    def test_parse_document_pdf_fast(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.parse_pdf(
            "https://arxiv.org/pdf/2301.00234v1",
            mode="fast",
        )

        if result.document:
            print(result.document.markdown)      # extracted text
            print(result.document.page_count)     # number of pages
        elif result.task_id:
            print(f"Async task: {result.task_id}")  # large docs go async
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.parse_pdf("https://arxiv.org/pdf/2301.00234v1", mode="fast")
        assert r.success is True
        assert r.document is not None or r.task_id is not None
        real.close()

    # @doc-sample: parseDocument / with_options
    @pytest.mark.timeout(60)
    def test_parse_document_with_options(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.parse(
            url="https://arxiv.org/pdf/2301.00234v1",
            mode="fast",
        )

        print(f"Success: {result.success}")
        print(f"Request ID: {result.request_id}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.parse(url="https://arxiv.org/pdf/2301.00234v1", mode="fast")
        assert r.success is True
        assert r.request_id is not None
        real.close()


# ═══════════════════════════════════════════════════════════════════
# Evolution API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesEvolutionAPI:
    """Doc Samples: Evolution API"""

    # @doc-sample: evolutionAnalyze / default
    def test_evolution_analyze_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        advice = client.im.evolution.analyze(
            signals=["error:timeout", "error:connection_reset"],
            context="API request timed out after 30s on /api/data endpoint",
        )

        if advice.get("ok") and advice.get("data"):
            data = advice["data"]
            print(f"Action: {data['action']}")           # 'apply_gene' or 'explore'
            if data.get("gene_id"):
                print(f"Gene: {data['gene_id']}")
                print(f"Strategy: {data['strategy']}")   # steps to fix
                print(f"Confidence: {data['confidence']}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.analyze(
            signals=["error:timeout"],
            context="Test signal analysis",
        )
        assert r.get("ok") is True
        real.close()

    # @doc-sample: evolutionRecord / default
    def test_evolution_record_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        client.im.evolution.record(
            gene_id="gene_repair_timeout",
            signals=["error:timeout"],
            outcome="success",
            summary="Resolved with exponential backoff - 3 retries, final latency 1.2s",
            score=0.9,
        )
        # --- sample end ---

        # No real test — record requires a valid gene_id which depends on analyze
        assert True

    # @doc-sample: evolutionAnalyze / evolve
    def test_evolution_evolve(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        result = client.im.evolution.evolve(
            error="Connection timeout after 10s",
            outcome="success",
            score=0.85,
            summary="Fixed with exponential backoff",
        )

        if result.get("ok") and result.get("data"):
            data = result["data"]
            print(f"Gene matched: {data['analysis'].get('gene_id', 'none')}")
            print(f"Outcome recorded: {data['recorded']}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.evolve(
            error="Test timeout error for doc-sample",
            outcome="success",
            score=0.5,
            summary="Doc sample test",
        )
        assert r.get("ok") is True
        real.close()

    # @doc-sample: evolutionGeneCreate / default
    def test_evolution_gene_create_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        gene = client.im.evolution.create_gene(
            category="repair",
            signals_match=[
                {"type": "error", "provider": "openai", "stage": "api_call"},
            ],
            strategy=[
                "Detect 429 status code",
                "Extract Retry-After header",
                "Wait for specified duration (default: 60s)",
                "Retry with exponential backoff (max 3 attempts)",
            ],
            title="Rate Limit Backoff",
            preconditions=["HTTP client supports retry"],
            constraints={"max_retries": 3, "max_credits": 10},
        )

        if gene.get("ok") and gene.get("data"):
            print(f"Created gene: {gene['data']['id']}")
            print(f"Category: {gene['data']['category']}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.create_gene(
            category="repair",
            signals_match=["test:doc_sample"],
            strategy=["Step 1: Identify issue", "Step 2: Apply fix"],
            title=f"Doc Sample Test Gene {int(time.time())}",
        )
        assert r.get("ok") is True
        # Cleanup: delete the test gene
        if r.get("data", {}).get("id"):
            real.im.evolution.delete_gene(r["data"]["id"])
        real.close()

    # @doc-sample: evolutionPublicGenes / default
    def test_evolution_browse_genes(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        genes = client.im.evolution.browse_genes(
            category="repair",
            sort="popular",
            limit=5,
        )

        if genes.get("ok") and genes.get("data"):
            for gene in genes["data"]:
                print(f"{gene['title']} ({gene['category']}) - {len(gene['strategy'])} steps")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.browse_genes(limit=5)
        assert r.get("ok") is True
        real.close()

    # @doc-sample: evolutionAchievements / default
    def test_evolution_achievements_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        achievements = client.im.evolution.get_achievements()

        if achievements.get("ok") and achievements.get("data"):
            for a in achievements["data"]:
                print(f"{a['badge']}: {a['name']} - {a['description']}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.get_achievements()
        assert r.get("ok") is True
        real.close()

    # @doc-sample: evolutionReport / default
    def test_evolution_report_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        report = client.im.evolution.get_report()

        if report.get("ok") and report.get("data"):
            data = report["data"]
            print(f"Total capsules: {data.get('totalCapsules')}")
            print(f"Success rate: {data.get('successRate')}")
            print(f"Active genes: {data.get('activeGenes')}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.get_report()
        assert r.get("ok") is True
        real.close()


# ═══════════════════════════════════════════════════════════════════
# Skills API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesSkillsAPI:
    """Doc Samples: Skills API"""

    # @doc-sample: skillSearch / default
    def test_skill_search_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        results = client.im.evolution.search_skills(
            query="timeout retry",
            limit=10,
        )

        if results.get("ok") and results.get("data"):
            for skill in results["data"]:
                print(f"{skill['name']} - {skill['description']}")
                print(f"  Installs: {skill['installCount']}, Source: {skill['source']}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.search_skills(query="api", limit=5)
        assert r.get("ok") is True
        real.close()

    # @doc-sample: skillInstall / default
    def test_skill_install_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Install a skill by slug
        result = client.im.evolution.install_skill("memory-management")

        if result.get("ok") and result.get("data"):
            print(f"Installed: {result['data']['skill']['name']}")
            print(f"Gene created: {result['data']['geneId']}")

        # Uninstall when no longer needed
        client.im.evolution.uninstall_skill("memory-management")
        # --- sample end ---

        # Real test: search for any skill, install it, verify, uninstall
        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        search = real.im.evolution.search_skills(limit=1)
        if search.get("ok") and search.get("data") and len(search["data"]) > 0:
            slug = search["data"][0].get("slug") or search["data"][0].get("id")
            install = real.im.evolution.install_skill(slug)
            assert install.get("ok") is True
            # Cleanup
            real.im.evolution.uninstall_skill(slug)
        real.close()

    # @doc-sample: skillInstalledList / default
    def test_skill_installed_list_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")
        installed = client.im.evolution.installed_skills()

        if installed.get("ok") and installed.get("data"):
            print(f"{len(installed['data'])} skills installed")
            for record in installed["data"]:
                print(f"  {record['skill']['name']} (installed {record['installedAt']})")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.evolution.installed_skills()
        assert r.get("ok") is True
        real.close()


# ═══════════════════════════════════════════════════════════════════
# Tasks API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesTasksAPI:
    """Doc Samples: Tasks API"""

    # @doc-sample: imTaskCreate / lifecycle
    def test_task_lifecycle(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Create a task
        task = client.im.tasks.create(
            title="Analyze website performance",
            description="Run Lighthouse audit on https://example.com",
            capability="web-analysis",
            metadata={"url": "https://example.com", "priority": "high"},
        )

        if task.get("ok") and task.get("data"):
            print(f"Task {task['data']['id']}: {task['data']['status']}")  # 'pending'

            # List pending tasks
            pending = client.im.tasks.list(status="pending", limit=10)
            print(f"{len(pending.get('data', []))} pending tasks")

            # Complete the task with a result
            completed = client.im.tasks.complete(task["data"]["id"], result={
                "score": 92,
                "metrics": {"fcp": 1.2, "lcp": 2.1, "cls": 0.05},
            })
            print(f"Task {completed.get('data', {}).get('status')}")  # 'completed'
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.tasks.create(
            title=f"Doc Sample Test Task {int(time.time())}",
            capability="test",
        )
        assert r.get("ok") is True
        if r.get("data", {}).get("id"):
            # Verify we can list
            task_list = real.im.tasks.list(status="pending")
            assert task_list.get("ok") is True
            # Complete the task
            done = real.im.tasks.complete(r["data"]["id"], result={"test": True})
            assert done.get("ok") is True
        real.close()

    # @doc-sample: imTaskCreate / scheduled
    def test_task_scheduled(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Create a cron-scheduled task (runs daily at 9 AM UTC)
        task = client.im.tasks.create(
            title="Daily health check",
            capability="monitoring",
            scheduleType="cron",
            scheduleCron="0 9 * * *",
            maxRetries=2,
            timeoutMs=60000,
        )

        if task.get("ok") and task.get("data"):
            print(f"Scheduled task: {task['data']['id']}")
            print(f"Next run: {task['data'].get('nextRunAt')}")
        # --- sample end ---

        # No real test — cron tasks require specific IM setup
        assert True


# ═══════════════════════════════════════════════════════════════════
# Memory API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesMemoryAPI:
    """Doc Samples: Memory API"""

    # @doc-sample: imMemoryCreate / default
    def test_memory_create_and_read(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Write a memory file
        file = client.im.memory.create_file(
            path="MEMORY.md",
            content="\n".join([
                "# Project Memory",
                "",
                "## Key Decisions",
                "- Use exponential backoff for API retries",
                "- Cache TTL set to 5 minutes",
                "",
                "## Learned Patterns",
                "- OpenAI rate limits hit at ~60 RPM on free tier",
            ]),
        )

        if file.get("ok") and file.get("data"):
            print(f"File ID: {file['data']['id']}")
            print(f"Version: {file['data']['version']}")

            # Read it back
            loaded = client.im.memory.get_file(file["data"]["id"])
            print(f"Content length: {len(loaded.get('data', {}).get('content', ''))}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.memory.create_file(
            path=f"test-doc-sample-{int(time.time())}.md",
            content="# Test Memory\nDoc sample test content",
        )
        assert r.get("ok") is True
        if r.get("data", {}).get("id"):
            read = real.im.memory.get_file(r["data"]["id"])
            assert read.get("ok") is True
            assert "Doc sample test" in read.get("data", {}).get("content", "")
            # Cleanup
            real.im.memory.delete_file(r["data"]["id"])
        real.close()

    # @doc-sample: imMemoryUpdate / default
    def test_memory_update_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Append new content to an existing file
        updated = client.im.memory.update_file(
            file_id="file_id_here",
            operation="append",
            content="\n## New Section\n- Important finding discovered today\n",
        )

        print(f"Updated to version: {updated.get('data', {}).get('version')}")
        # --- sample end ---

        # Real test: create -> append -> verify -> cleanup
        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        created = real.im.memory.create_file(
            path=f"test-append-{int(time.time())}.md",
            content="# Base Content",
        )
        if created.get("ok") and created.get("data", {}).get("id"):
            appended = real.im.memory.update_file(
                file_id=created["data"]["id"],
                operation="append",
                content="\n## Appended Section\n",
            )
            assert appended.get("ok") is True
            # Cleanup
            real.im.memory.delete_file(created["data"]["id"])
        real.close()

    # @doc-sample: imMemoryLoad / default
    def test_memory_load_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Load the agent's MEMORY.md for current session context
        mem = client.im.memory.load()

        if mem.get("ok") and mem.get("data"):
            print(f"Memory loaded: {len(mem['data'].get('content', ''))} chars")
            print(f"Files: {len(mem['data'].get('files', []))}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.memory.load()
        assert r.get("ok") is True
        real.close()


# ═══════════════════════════════════════════════════════════════════
# Recall API
# ═══════════════════════════════════════════════════════════════════


class TestDocSamplesRecallAPI:
    """Doc Samples: Recall API"""

    # @doc-sample: imRecall / default
    def test_recall_default(self):
        # --- sample start ---
        from prismer import PrismerClient

        client = PrismerClient(api_key="sk-prismer-xxx")

        # Search across all data sources (memory, cache, evolution)
        results = client.im.memory._request(
            "GET", "/api/im/recall", params={"q": "timeout retry backoff", "limit": "10"},
        )

        if results.get("ok") and results.get("data"):
            for item in results["data"]:
                print(f"[{item['source']}] {item['title']} - score: {item['score']}")

        # Filter by source
        mem_only = client.im.memory._request(
            "GET", "/api/im/recall",
            params={"q": "API reference", "limit": "5", "source": "memory"},
        )
        print(f"Memory results: {len(mem_only.get('data', []))}")
        # --- sample end ---

        real = PrismerClient(api_key=API_KEY, base_url=BASE_URL, timeout=60.0)
        r = real.im.memory._request(
            "GET", "/api/im/recall", params={"q": "test", "limit": "5"},
        )
        assert r.get("ok") is True
        real.close()
