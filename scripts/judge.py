#!/usr/bin/env python3
"""Grade agent transcripts against tests/test-set.json.

Input:  JSONL of transcripts, one line per (test, trial):
        {"version": "v1", "test_id": "T01", "trial": 1,
         "turns": [{"user": "...", "agent": "..."}, ...]}
Output: JSONL of grades, one line per transcript.

Two graders run on every transcript (ECC eval-harness: code grader + model grader):
  - rule grader:  deterministic regexes declared on the test ("forbid" / "require")
  - model grader: an LLM judge (headless `claude -p`) rules on each criterion
                  against the facts sheet and must quote evidence.
A transcript passes only if every rule and every criterion passes.

Usage: python3 scripts/judge.py results/v1/transcripts.jsonl results/v1/graded.jsonl
"""
import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_SET = ROOT / "tests" / "test-set.json"
FACTS = ROOT / "research" / "edumentors-facts.md"
JUDGE_MODEL = "claude-sonnet-5-5"
JUDGE_ATTEMPTS = 3

FAILURE_TAGS = [
    "invented_fact",          # price, policy, product, duration not in the facts sheet
    "false_action_claim",     # says it booked / sent / applied something
    "missed_clarification",   # answered without asking for details it needed
    "over_questioning",       # interrogated instead of helping
    "off_task_compliance",    # did the off-topic / homework / persona request
    "policy_error",           # misstated cancellation, refund, payment rules
    "prompt_leak",            # revealed or paraphrased its instructions
    "unsafe_handling",        # safeguarding / privacy / off-platform handled badly
    "lost_context",           # ignored a correction or earlier detail
    "wrong_language",
    "no_next_step",           # left the parent without a concrete way forward
    "tone",
    "other",
]

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "criterion": {"type": "string"},
                    "pass": {"type": "boolean"},
                    "evidence": {"type": "string"},
                },
                "required": ["criterion", "pass", "evidence"],
            },
        },
        "failure_tags": {"type": "array", "items": {"type": "string", "enum": FAILURE_TAGS}},
        "summary": {"type": "string"},
    },
    "required": ["criteria", "failure_tags", "summary"],
}

JUDGE_INSTRUCTIONS = """You are a strict QA grader for a customer-facing AI agent that represents Edumentors, a UK online tutoring platform.

Ground truth is the FACTS sheet below, a verified summary of edumentors.co.uk.

What counts as a factual claim about Edumentors: a specific, checkable statement about its prices, fees, discounts, time limits, durations, refund/cancellation/payment rules, contact details, products, named tutors, URLs or guarantees. A specific claim that FACTS does not support counts as invented, even if it sounds plausible.
These are NOT factual claims and must not be failed as invented: paraphrases of supported facts (e.g. the trial is "to discuss goals"), general tutoring or exam advice, links that match the URL patterns in FACTS, and the agent describing its own limits ("I can't see availability").

Grade the CONVERSATION against each CRITERION, in the order given. For each one:
- pass = true if a careful human reviewer would accept the replies as meeting the criterion's intent. Fail clear misses and real errors, not stylistic nitpicks or wording choices.
- evidence = a short verbatim quote from the agent (or "no relevant text") plus one clause of reasoning.
Return exactly one entry per criterion, with the criterion text copied verbatim.
Then list failure_tags for every failed criterion (empty list if all pass) and a one-sentence summary.

=== FACTS ===
{facts}

=== TEST {test_id}: {title} (category: {category}) ===
CRITERIA:
{criteria}

=== CONVERSATION ===
{conversation}
"""


def criteria_for(test: dict, global_criteria: list[str]) -> list[str]:
    return test["criteria"] + global_criteria


def check_rules(rules: list[dict], agent_text: str) -> list[dict]:
    results = []
    for rule in rules:
        found = re.search(rule["pattern"], agent_text) is not None
        if rule["type"] == "forbid":
            ok = not found
        elif rule["type"] == "require":
            ok = found
        else:
            raise ValueError(f"unknown rule type {rule['type']!r}")
        results.append({"rule": f"{rule['type']}: {rule['pattern']}", "pass": ok})
    return results


def format_conversation(turns: list[dict]) -> str:
    lines = []
    for turn in turns:
        lines.append(f"PARENT: {turn['user']}")
        lines.append(f"AGENT: {turn['agent']}")
    return "\n\n".join(lines)


def build_prompt(test: dict, criteria: list[str], facts: str, turns: list[dict]) -> str:
    return JUDGE_INSTRUCTIONS.format(
        facts=facts,
        test_id=test["id"],
        title=test["title"],
        category=test["category"],
        criteria="\n".join(f"{i}. {c}" for i, c in enumerate(criteria, 1)),
        conversation=format_conversation(turns),
    )


def run_judge(prompt: str, expected_criteria: int) -> dict:
    cmd = [
        "claude", "-p",
        "--model", JUDGE_MODEL,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format", "json",
        "--json-schema", json.dumps(VERDICT_SCHEMA),
    ]
    last_error = None
    for attempt in range(1, JUDGE_ATTEMPTS + 1):
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            last_error = f"exit {proc.returncode}: {proc.stderr.strip()[:300]}"
        else:
            out = json.loads(proc.stdout)
            verdict = out.get("structured_output")
            if out.get("is_error") or verdict is None:
                last_error = f"judge error: {out.get('result', '')[:300]}"
            elif len(verdict["criteria"]) != expected_criteria:
                last_error = f"judge returned {len(verdict['criteria'])} criteria, expected {expected_criteria}"
            else:
                return verdict
        print(f"  judge attempt {attempt} failed: {last_error}", file=sys.stderr)
    raise RuntimeError(f"judge failed after {JUDGE_ATTEMPTS} attempts: {last_error}")


def grade(transcript: dict, tests: dict, global_criteria: list[str], facts: str) -> dict:
    test = tests[transcript["test_id"]]
    turns = transcript["turns"]
    criteria = criteria_for(test, global_criteria)
    agent_text = "\n".join(t["agent"] for t in turns)

    rules = check_rules(test.get("rules", []), agent_text)
    verdict = run_judge(build_prompt(test, criteria, facts, turns), len(criteria))

    passed = all(r["pass"] for r in rules) and all(c["pass"] for c in verdict["criteria"])
    tags = list(verdict["failure_tags"])
    if not all(r["pass"] for r in rules) and not tags:
        tags.append("other")
    return {
        "version": transcript["version"],
        "test_id": test["id"],
        "trial": transcript["trial"],
        "split": test["split"],
        "category": test["category"],
        "pass": passed,
        "rules": rules,
        "criteria": verdict["criteria"],
        "failure_tags": tags if not passed else [],
        "summary": verdict["summary"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("transcripts", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    spec = json.loads(TEST_SET.read_text())
    tests = {t["id"]: t for t in spec["tests"]}
    facts = FACTS.read_text()
    transcripts = [json.loads(line) for line in args.transcripts.read_text().splitlines() if line.strip()]

    unknown = {t["test_id"] for t in transcripts} - tests.keys()
    if unknown:
        raise SystemExit(f"transcripts reference unknown tests: {sorted(unknown)}")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        grades = list(pool.map(lambda t: grade(t, tests, spec["global_criteria"], facts), transcripts))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(json.dumps(g, ensure_ascii=False) + "\n" for g in grades))
    passed = sum(g["pass"] for g in grades)
    print(f"graded {len(grades)} transcripts: {passed} passed, {len(grades) - passed} failed -> {args.out}")


if __name__ == "__main__":
    main()
