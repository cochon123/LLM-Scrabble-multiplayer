from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
THIS_DIR = Path(__file__).resolve().parent
HOLDOUT_DATASET = ROOT / "runtime-bench" / "scrabble-toolcall" / "datasets" / "autoresearch-holdout-30.jsonl"
RUNS_DIR = ROOT / "runtime-bench" / "scrabble-toolcall" / "runs"
TECHNIQUES_FILE = THIS_DIR / "techniques.txt"
OPENROUTER_API_KEY = "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"

sys.path.insert(0, str(THIS_DIR))
from score_run import compute_run_score  # noqa: E402


def load_techniques() -> list[str]:
    values = [
        line.strip()
        for line in TECHNIQUES_FILE.read_text(encoding="utf8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not values:
        raise RuntimeError(f"No active techniques found in {TECHNIQUES_FILE}")
    return values


def ensure_datasets() -> None:
    if HOLDOUT_DATASET.exists():
        return
    subprocess.run([sys.executable, str(THIS_DIR / "prepare.py")], cwd=ROOT, check=True)


def main() -> None:
    ensure_datasets()
    techniques = load_techniques()
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    run_dir = RUNS_DIR / f"autoresearch-holdout-{timestamp}"
    env = dict(os.environ)
    env["OPENROUTER_API_KEY"] = OPENROUTER_API_KEY

    command = [
        sys.executable,
        "-m",
        "benchmarks.scrabble_toolcall.cli",
        "run",
        "--provider",
        "openai_compatible",
        "--base-url",
        "https://openrouter.ai/api/v1/chat/completions",
        "--model",
        "deepseek/deepseek-v3.2",
        "--dataset",
        str(HOLDOUT_DATASET),
        "--out",
        str(run_dir),
        "--concurrency",
        "5",
        "--timeout-seconds",
        "250",
        "--retries",
        "2",
        "--temperature",
        "0",
        "--api-key-env",
        "OPENROUTER_API_KEY",
        "--techniques",
        *techniques,
    ]
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    result = compute_run_score(run_dir)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
