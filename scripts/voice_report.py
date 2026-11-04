#!/usr/bin/env python3
"""Compare voice runs: speed, length, filler and judge pass rate.

Each argument is a results directory holding transcripts.jsonl (from
scripts/run_voice_tests.mjs) and graded.jsonl (from scripts/judge.py --tests tests/voice-set.json).

Usage: python3 scripts/voice_report.py results/voice/v3 results/voice/v4 --out results/voice/report.md
"""
import argparse
import json
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent.parent
VOICE_SET = ROOT / "tests" / "voice-set.json"
LONG_ANSWER_WORDS = 40
REPETITION_CRITERION = "Does not repeat itself"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def summarise(run_dir: Path) -> tuple[str, dict, dict]:
    transcripts = load_jsonl(run_dir / "transcripts.jsonl")
    graded = load_jsonl(run_dir / "graded.jsonl")
    versions = {r["version"] for r in transcripts}
    if len(versions) != 1:
        raise SystemExit(f"{run_dir} mixes versions {sorted(versions)}")
    turns = [t for r in transcripts for t in r["turns"]]
    repeats = sum(
        not c["pass"] for g in graded for c in g["criteria"] if c["criterion"].lstrip("0123456789. ").startswith(REPETITION_CRITERION)
    )
    metrics = {
        "Judge pass rate (all criteria)": f"{sum(g['pass'] for g in graded)}/{len(graded)}",
        "Median time to first word": f"{median(t['first_word_ms'] for t in turns) / 1000:.1f} s",
        "Median time to the real answer": f"{median(t['answer_start_ms'] for t in turns) / 1000:.1f} s",
        "Median speaking time per answer": f"{median(t['speaking_ms'] for t in turns) / 1000:.1f} s",
        "Median words per answer": f"{median(t['answer_words'] for t in turns):.0f}",
        f"Answers over {LONG_ANSWER_WORDS} words": f"{sum(t['answer_words'] > LONG_ANSWER_WORDS for t in turns)}/{len(turns)}",
        "Answers starting with a filler": f"{sum(bool(t['filler']) for t in turns)}/{len(turns)}",
        "Runs failing 'does not repeat itself'": f"{repeats}/{len(graded)}",
    }
    per_test = {}
    for r in transcripts:
        per_test.setdefault(r["test_id"], []).extend(r["turns"])
    passes = {}
    for g in graded:
        passes.setdefault(g["test_id"], []).append(g["pass"])
    per_test_cells = {
        tid: f"{sum(passes.get(tid, []))}/{len(passes.get(tid, []))} pass · "
             f"{median(t['answer_words'] for t in ts):.0f} words · {median(t['speaking_ms'] for t in ts) / 1000:.0f} s"
        for tid, ts in per_test.items()
    }
    return versions.pop(), metrics, per_test_cells


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    tests = json.loads(VOICE_SET.read_text())["tests"]
    summaries = [summarise(d) for d in args.runs]
    versions = [s[0] for s in summaries]
    header = "| | " + " | ".join(versions) + " |\n|---|" + "---|" * len(versions)

    out = ["# Voice eval report", "", "## Headline", "", header]
    for label in summaries[0][1]:
        out.append(f"| {label} | " + " | ".join(s[1][label] for s in summaries) + " |")
    out += ["", "## Per test (median per answer)", "", "| Test | Title | " + " | ".join(versions) + " |",
            "|---|---|" + "---|" * len(versions)]
    for t in tests:
        out.append(f"| {t['id']} | {t['title']} | " + " | ".join(s[2].get(t["id"], "–") for s in summaries) + " |")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(out) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
