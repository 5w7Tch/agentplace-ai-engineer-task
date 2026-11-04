#!/usr/bin/env python3
"""Compare graded runs and write a markdown report.

Each input is a graded JSONL written by scripts/judge.py (one version per file).
Metrics, per ECC eval-harness:
  pass@1  share of all transcripts (test x trial) that pass
  pass^k  share of tests where every one of the k trials passes (stability)

Usage: python3 scripts/report.py results/v1/graded.jsonl results/v2/graded.jsonl --out results/report.md
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_SET = ROOT / "tests" / "test-set.json"


def load(path: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    versions = {r["version"] for r in rows}
    if len(versions) != 1:
        raise SystemExit(f"{path} mixes versions {sorted(versions)}; expected exactly one")
    return rows


def pct(num: int, den: int) -> str:
    return f"{num}/{den} ({100 * num / den:.0f}%)" if den else "–"


def by_test(rows: list[dict]) -> dict[str, list[bool]]:
    trials = defaultdict(list)
    for r in rows:
        trials[r["test_id"]].append(r["pass"])
    return trials


def summarise(rows: list[dict], keep=lambda r: True) -> tuple[str, str]:
    subset = [r for r in rows if keep(r)]
    trials = by_test(subset)
    pass_at_1 = pct(sum(r["pass"] for r in subset), len(subset))
    pass_all = pct(sum(all(t) for t in trials.values()), len(trials))
    return pass_at_1, pass_all


def render(runs: dict[str, list[dict]], tests: list[dict]) -> str:
    versions = list(runs)
    header = "| | " + " | ".join(versions) + " |\n|---|" + "---|" * len(versions)
    k = max(len(v) for rows in runs.values() for v in by_test(rows).values())
    out = ["# Eval report", ""]

    out += ["## Headline", "", header]
    splits = list(dict.fromkeys(t["split"] for t in tests))
    rows = [("All tests", lambda r: True)]
    rows += [(f"Split {s}", lambda r, s=s: r["split"] == s) for s in splits]
    for label, keep in rows:
        cells = [summarise(runs[v], keep) for v in versions]
        out.append(f"| {label}: pass@1 | " + " | ".join(c[0] for c in cells) + " |")
        out.append(f"| {label}: pass^{k} | " + " | ".join(c[1] for c in cells) + " |")
    out.append("")

    categories = sorted({t["category"] for t in tests})
    out += ["## pass@1 by category", "", header]
    for cat in categories:
        cells = [summarise(runs[v], lambda r, c=cat: r["category"] == c)[0] for v in versions]
        out.append(f"| {cat} | " + " | ".join(cells) + " |")
    out.append("")

    tag_counts = {v: Counter(tag for r in runs[v] for tag in r["failure_tags"]) for v in versions}
    all_tags = sorted({t for c in tag_counts.values() for t in c}, key=lambda t: -tag_counts[versions[0]][t])
    out += ["## Failure tags (transcripts carrying each tag)", "", header]
    for tag in all_tags:
        out.append(f"| {tag} | " + " | ".join(str(tag_counts[v][tag]) for v in versions) + " |")
    out.append("")

    out += ["## Per test (trials passed)", "",
            "| Test | Title | Category | Split | " + " | ".join(versions) + " |",
            "|---|---|---|---|" + "---|" * len(versions)]
    trials = {v: by_test(runs[v]) for v in versions}
    for t in tests:
        cells = []
        for v in versions:
            results = trials[v].get(t["id"])
            cells.append(f"{sum(results)}/{len(results)}" if results else "–")
        out.append(f"| {t['id']} | {t['title']} | {t['category']} | {t['split']} | " + " | ".join(cells) + " |")
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graded", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    tests = json.loads(TEST_SET.read_text())["tests"]
    runs = {}
    for path in args.graded:
        rows = load(path)
        runs[rows[0]["version"]] = rows

    args.out.write_text(render(runs, tests))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
