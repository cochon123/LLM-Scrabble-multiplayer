from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Iterable

from .types import BenchmarkCase


def load_dataset(dataset_path: str | Path) -> list[BenchmarkCase]:
    path = Path(dataset_path)
    cases: list[BenchmarkCase] = []
    for line in path.read_text(encoding="utf8").splitlines():
        if line.strip():
            cases.append(json.loads(line))
    return cases


def write_jsonl(path: str | Path, records: Iterable[dict]) -> None:
    path_obj = Path(path)
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    with path_obj.open("w", encoding="utf8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False))
            handle.write("\n")


def append_jsonl(path: str | Path, record: dict) -> None:
    path_obj = Path(path)
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    with path_obj.open("a", encoding="utf8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False))
        handle.write("\n")


def generate_dataset_via_ts(
    out: str | Path,
    count: int = 500,
    simple: int = 200,
    medium: int = 200,
    hard: int = 100,
    seed: int = 1,
    dictionary: str = "public/dictionary/en_large.txt",
) -> None:
    root = Path(__file__).resolve().parents[2]
    command = [
        str(root / "node_modules" / ".bin" / "tsx"),
        "src/bench/engine_cli.ts",
        "generate-dataset",
        "--out",
        str(out),
        "--count",
        str(count),
        "--simple",
        str(simple),
        "--medium",
        str(medium),
        "--hard",
        str(hard),
        "--seed",
        str(seed),
        "--dictionary",
        dictionary,
    ]
    env = os.environ.copy()
    subprocess.run(command, cwd=root, env=env, check=True)
