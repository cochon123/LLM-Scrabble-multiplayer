from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEARCH_DATASET = ROOT / "runtime-bench" / "scrabble-toolcall" / "datasets" / "autoresearch-search-30.jsonl"
HOLDOUT_DATASET = ROOT / "runtime-bench" / "scrabble-toolcall" / "datasets" / "autoresearch-holdout-30.jsonl"


def run_generate(out: Path, seed: int, force: bool) -> None:
    if out.exists() and not force:
        print(f"skip existing dataset: {out}")
        return

    out.parent.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "benchmarks.scrabble_toolcall.cli",
        "generate-dataset",
        "--count",
        "30",
        "--simple",
        "10",
        "--medium",
        "10",
        "--hard",
        "10",
        "--seed",
        str(seed),
        "--dictionary",
        "public/dictionary/en-large.txt",
        "--out",
        str(out),
    ]
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    run_generate(SEARCH_DATASET, seed=4101, force=args.force)
    run_generate(HOLDOUT_DATASET, seed=4102, force=args.force)

    print("search_dataset", SEARCH_DATASET)
    print("holdout_dataset", HOLDOUT_DATASET)


if __name__ == "__main__":
    main()
