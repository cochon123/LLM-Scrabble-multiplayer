from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from .types import RunSummary, TechniqueResult


def summarize_results(
    results: Iterable[TechniqueResult],
    provider: str,
    models: list[str],
    dataset_path: str,
    techniques: list[str],
) -> RunSummary:
    items = list(results)
    by_technique: dict[str, dict] = {}
    by_difficulty: dict[str, dict[str, dict]] = defaultdict(dict)
    failure_breakdown: Counter[str] = Counter()
    failure_breakdown_by_technique: dict[str, Counter[str]] = defaultdict(Counter)

    for technique in techniques:
        subset = [item for item in items if item["technique"] == technique]
        success = sum(1 for item in subset if item["success"])
        by_technique[technique] = {
            "total": len(subset),
            "success": success,
            "success_rate": (success / len(subset) * 100) if subset else 0.0,
            "avg_latency_ms": round(sum(item["latency_ms"] for item in subset) / len(subset), 2) if subset else 0.0,
        }

    for difficulty in ["simple", "medium", "hard"]:
        for technique in techniques:
            subset = [item for item in items if item["difficulty"] == difficulty and item["technique"] == technique]
            success = sum(1 for item in subset if item["success"])
            by_difficulty[difficulty][technique] = {
                "total": len(subset),
                "success": success,
                "success_rate": (success / len(subset) * 100) if subset else 0.0,
            }

    for item in items:
        cause = item.get("failure_cause")
        if cause:
            failure_breakdown[cause] += 1
            failure_breakdown_by_technique[item["technique"]][cause] += 1

    return {
        "provider": provider,
        "models": models,
        "dataset_path": dataset_path,
        "techniques": techniques,  # type: ignore[typeddict-item]
        "totals": {
            "total": len(items),
            "success": sum(1 for item in items if item["success"]),
            "success_rate": (sum(1 for item in items if item["success"]) / len(items) * 100) if items else 0.0,
        },
        "by_technique": by_technique,
        "by_difficulty": dict(by_difficulty),
        "failure_breakdown": dict(failure_breakdown),
        "failure_breakdown_by_technique": {
            technique: dict(counter) for technique, counter in failure_breakdown_by_technique.items()
        },
    }


def write_summary(path: str | Path, summary: RunSummary) -> None:
    path_obj = Path(path)
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    path_obj.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf8")


def render_charts(summary: RunSummary, charts_dir: str | Path) -> None:
    charts_path = Path(charts_dir)
    charts_path.mkdir(parents=True, exist_ok=True)
    _plot_overall_validity(summary, charts_path / "overall_validity.png")
    _plot_validity_by_difficulty(summary, charts_path / "validity_by_difficulty.png")
    _plot_failure_causes_overall(summary, charts_path / "failure_causes_overall.png")
    _plot_failure_causes_by_technique(summary, charts_path / "failure_causes_by_technique.png")


def _plot_overall_validity(summary: RunSummary, out: Path) -> None:
    techniques = list(summary["by_technique"].keys())
    values = [summary["by_technique"][item]["success_rate"] for item in techniques]
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.bar(techniques, values, color=["#2563eb", "#14b8a6", "#f97316"])
    ax.set_ylim(0, 100)
    ax.set_ylabel("% valid")
    ax.set_title("Validité globale par technique")
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_validity_by_difficulty(summary: RunSummary, out: Path) -> None:
    difficulties = ["simple", "medium", "hard"]
    techniques = summary["techniques"]
    x = range(len(techniques))
    width = 0.22
    fig, ax = plt.subplots(figsize=(9, 4.8))
    colors = {"simple": "#60a5fa", "medium": "#34d399", "hard": "#f59e0b"}
    offsets = {"simple": -width, "medium": 0.0, "hard": width}
    for difficulty in difficulties:
        values = [summary["by_difficulty"][difficulty][technique]["success_rate"] for technique in techniques]
        ax.bar([idx + offsets[difficulty] for idx in x], values, width=width, label=difficulty, color=colors[difficulty])
    ax.set_xticks(list(x), techniques)
    ax.set_ylim(0, 100)
    ax.set_ylabel("% valid")
    ax.set_title("Validité par difficulté")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_failure_causes_overall(summary: RunSummary, out: Path) -> None:
    items = sorted(summary["failure_breakdown"].items(), key=lambda item: (-item[1], item[0]))
    labels = [item[0] for item in items]
    values = [item[1] for item in items]
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar(labels, values, color="#ef4444")
    ax.set_ylabel("count")
    ax.set_title("Causes d'échec globales")
    ax.tick_params(axis="x", rotation=35)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_failure_causes_by_technique(summary: RunSummary, out: Path) -> None:
    techniques = summary["techniques"]
    causes = sorted(summary["failure_breakdown"].keys())
    fig, ax = plt.subplots(figsize=(10, 5))
    bottoms = [0] * len(techniques)
    palette = [
        "#ef4444",
        "#f97316",
        "#f59e0b",
        "#10b981",
        "#06b6d4",
        "#3b82f6",
        "#8b5cf6",
        "#ec4899",
    ]
    for index, cause in enumerate(causes):
        values = []
        for technique in techniques:
            subset_count = summary["failure_breakdown_by_technique"].get(technique, {}).get(cause, 0)
            values.append(subset_count)
        ax.bar(techniques, values, bottom=bottoms, label=cause, color=palette[index % len(palette)])
        bottoms = [bottoms[idx] + values[idx] for idx in range(len(values))]
    ax.set_ylabel("count")
    ax.set_title("Causes d'échec par technique")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)
