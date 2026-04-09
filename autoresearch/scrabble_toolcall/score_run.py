from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

PENALTY_WEIGHTS = {
    "overwrote_existing_tile": 35.0,
    "not_json": 15.0,
    "out_of_bounds": 10.0,
    "missing_cells": 5.0,
}


def load_results(run_dir: Path) -> list[dict[str, Any]]:
    raw_path = run_dir / "raw_results.jsonl"
    if not raw_path.exists():
        raise FileNotFoundError(f"Missing raw results: {raw_path}")
    return [json.loads(line) for line in raw_path.read_text(encoding="utf8").splitlines() if line.strip()]


def compute_technique_score(items: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(items)
    success = sum(1 for item in items if item.get("success"))
    failures = Counter(item.get("failure_cause") for item in items if item.get("failure_cause"))
    success_rate = success / total if total else 0.0
    penalties = {
        cause: PENALTY_WEIGHTS[cause] * (failures.get(cause, 0) / total) for cause in PENALTY_WEIGHTS if total
    }
    score = 100.0 * success_rate - sum(penalties.values())
    return {
        "total": total,
        "success": success,
        "success_rate": round(success_rate * 100.0, 2),
        "failures": dict(failures),
        "penalties": {key: round(value, 4) for key, value in penalties.items()},
        "score": round(score, 4),
    }


def compute_run_score(run_dir: Path) -> dict[str, Any]:
    rows = load_results(run_dir)
    by_technique: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
      by_technique[str(row["technique"])].append(row)

    scored = {technique: compute_technique_score(items) for technique, items in by_technique.items()}
    if not scored:
        raise RuntimeError("No benchmark rows found.")

    best_technique = max(scored.items(), key=lambda item: item[1]["score"])[0]
    return {
        "run_dir": str(run_dir),
        "rows": len(rows),
        "techniques": scored,
        "best_technique": best_technique,
        "score": scored[best_technique]["score"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    args = parser.parse_args()
    result = compute_run_score(Path(args.run))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
