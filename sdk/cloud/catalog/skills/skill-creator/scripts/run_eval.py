#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Claude to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import re
import tempfile
import select
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

if __package__:
    from .utils import parse_skill_md
else:
    from utils import parse_skill_md


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so the command file
    we create ends up where claude -p will look for it.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def run_single_query(
    query: str, skill_name: str, skill_description: str, timeout: int,
    project_root: str, model: str | None = None,
) -> bool:
    """Evaluate only a temporary probe skill; never write into the user's repo."""
    if os.environ.get("PRISMER_ALLOW_PAID_EVAL") != "1":
        raise PermissionError("Set PRISMER_ALLOW_PAID_EVAL=1 after approving evaluation cost")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_name):
        raise ValueError("Unsafe skill name")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    clean_name = f"{skill_name}-skill-{uuid.uuid4().hex[:8]}"
    with tempfile.TemporaryDirectory(prefix="skill-trigger-") as directory:
        skill_dir = Path(directory) / ".claude" / "skills" / clean_name
        skill_dir.mkdir(parents=True)
        description = "\\n  ".join(skill_description.splitlines())
        (skill_dir / "SKILL.md").write_text(
            f"---\\nname: {clean_name}\\ndescription: |\\n  {description}\\n---\\n"
            "Report that this probe skill was selected. Do not execute any other action.\\n",
            encoding="utf-8",
        )
        cmd = ["claude", "-p", query, "--output-format", "stream-json", "--verbose",
               "--bare", "--tools", "Read,Skill", "--allowedTools", "Read,Skill",
               "--permission-mode", "dontAsk", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
               "--no-session-persistence", "--max-budget-usd", "0.25"]
        if model:
            cmd.extend(["--model", model])
        # communicate drains both pipes; errors are never scored as negatives.
        completed = subprocess.run(cmd, cwd=directory, env=dict(os.environ),
                                   capture_output=True, text=True, timeout=timeout)
        if completed.returncode:
            raise RuntimeError(f"Claude evaluation exited {completed.returncode}")
        triggered, finished = False, False
        for line in completed.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") != "tool_use":
                        continue
                    args = block.get("input", {})
                    if block.get("name") == "Skill":
                        triggered |= clean_name in args.get("skill", "")
                    elif block.get("name") == "Read":
                        triggered |= clean_name in args.get("file_path", "")
            elif event.get("type") == "result":
                if event.get("is_error") or event.get("subtype") not in (None, "success"):
                    raise RuntimeError("Claude evaluation returned an error result")
                finished = True
        if not finished:
            raise RuntimeError("Claude evaluation produced no successful terminal result")
        return triggered

def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    if not eval_set or num_workers < 1 or runs_per_query < 1 or timeout <= 0:
        raise ValueError('Non-empty eval set and positive workers/runs/timeout required')
    if not 0 < trigger_threshold <= 1:
        raise ValueError('trigger_threshold must be in (0, 1]')
    if len({item['query'] for item in eval_set}) != len(eval_set):
        raise ValueError('Duplicate queries make train/test membership ambiguous')
    if len(eval_set) * runs_per_query > 300 or num_workers > 10:
        raise ValueError('Evaluation exceeds 300-call or 10-worker safety budget')
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                raise RuntimeError('Evaluation incomplete; failed calls cannot count as negative triggers') from e

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for claude -p (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
