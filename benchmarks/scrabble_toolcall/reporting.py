from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from .types import ContextRunSummary, RunSummary, TechniqueResult


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


def summarize_context_results(
    results: Iterable[TechniqueResult],
    provider: str,
    models: list[str],
    dataset_path: str,
    techniques: list[str],
    context_formats: list[str],
) -> ContextRunSummary:
    items = list(results)
    by_context_format: dict[str, dict] = {}
    by_technique_and_context_format: dict[str, dict[str, Any]] = defaultdict(dict)
    by_difficulty_and_context_format: dict[str, dict[str, Any]] = defaultdict(dict)
    failure_breakdown_by_context_format: dict[str, Counter[str]] = defaultdict(Counter)

    for context_format in context_formats:
        subset = [item for item in items if item.get("context_format") == context_format]
        success = sum(1 for item in subset if item["success"])
        prompt_values = [_usage_prompt_tokens(item.get("usage")) for item in subset if _usage_prompt_tokens(item.get("usage")) is not None]
        total_values = [_usage_total_tokens(item.get("usage")) for item in subset if _usage_total_tokens(item.get("usage")) is not None]
        valid_scores = [float(item["move_score"]) for item in subset if item["success"] and isinstance(item.get("move_score"), (int, float))]
        successful_total_values = [
            _usage_total_tokens(item.get("usage"))
            for item in subset
            if item["success"] and _usage_total_tokens(item.get("usage")) is not None
        ]
        by_context_format[context_format] = {
            "total": len(subset),
            "success": success,
            "success_rate": (success / len(subset) * 100) if subset else 0.0,
            "avg_latency_ms": round(sum(item["latency_ms"] for item in subset) / len(subset), 2) if subset else 0.0,
            "avg_prompt_tokens": round(sum(prompt_values) / len(prompt_values), 2) if prompt_values else None,
            "avg_total_tokens": round(sum(total_values) / len(total_values), 2) if total_values else None,
            "avg_score_valid": round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else None,
            "avg_total_tokens_per_success": round(sum(successful_total_values) / len(successful_total_values), 2)
            if successful_total_values
            else None,
        }

    for technique in techniques:
        for context_format in context_formats:
            subset = [
                item
                for item in items
                if item["technique"] == technique and item.get("context_format") == context_format
            ]
            success = sum(1 for item in subset if item["success"])
            prompt_values = [_usage_prompt_tokens(item.get("usage")) for item in subset if _usage_prompt_tokens(item.get("usage")) is not None]
            total_values = [_usage_total_tokens(item.get("usage")) for item in subset if _usage_total_tokens(item.get("usage")) is not None]
            valid_scores = [float(item["move_score"]) for item in subset if item["success"] and isinstance(item.get("move_score"), (int, float))]
            by_technique_and_context_format[technique][context_format] = {
                "total": len(subset),
                "success": success,
                "success_rate": (success / len(subset) * 100) if subset else 0.0,
                "avg_prompt_tokens": round(sum(prompt_values) / len(prompt_values), 2) if prompt_values else None,
                "avg_total_tokens": round(sum(total_values) / len(total_values), 2) if total_values else None,
                "avg_score_valid": round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else None,
            }

    for difficulty in ["simple", "medium", "hard"]:
        for context_format in context_formats:
            subset = [
                item
                for item in items
                if item["difficulty"] == difficulty and item.get("context_format") == context_format
            ]
            success = sum(1 for item in subset if item["success"])
            prompt_values = [_usage_prompt_tokens(item.get("usage")) for item in subset if _usage_prompt_tokens(item.get("usage")) is not None]
            total_values = [_usage_total_tokens(item.get("usage")) for item in subset if _usage_total_tokens(item.get("usage")) is not None]
            valid_scores = [float(item["move_score"]) for item in subset if item["success"] and isinstance(item.get("move_score"), (int, float))]
            by_difficulty_and_context_format[difficulty][context_format] = {
                "total": len(subset),
                "success": success,
                "success_rate": (success / len(subset) * 100) if subset else 0.0,
                "avg_prompt_tokens": round(sum(prompt_values) / len(prompt_values), 2) if prompt_values else None,
                "avg_total_tokens": round(sum(total_values) / len(total_values), 2) if total_values else None,
                "avg_score_valid": round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else None,
            }

    for item in items:
        cause = item.get("failure_cause")
        if cause and item.get("context_format"):
            failure_breakdown_by_context_format[item["context_format"]][cause] += 1

    return {
        "provider": provider,
        "models": models,
        "dataset_path": dataset_path,
        "techniques": techniques,  # type: ignore[typeddict-item]
        "context_formats": context_formats,  # type: ignore[typeddict-item]
        "totals": {
            "total": len(items),
            "success": sum(1 for item in items if item["success"]),
            "success_rate": (sum(1 for item in items if item["success"]) / len(items) * 100) if items else 0.0,
        },
        "by_context_format": by_context_format,
        "by_technique_and_context_format": dict(by_technique_and_context_format),
        "by_difficulty_and_context_format": dict(by_difficulty_and_context_format),
        "failure_breakdown_by_context_format": {
            context_format: dict(counter) for context_format, counter in failure_breakdown_by_context_format.items()
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


def render_context_charts(summary: ContextRunSummary, charts_dir: str | Path) -> None:
    charts_path = Path(charts_dir)
    charts_path.mkdir(parents=True, exist_ok=True)
    _plot_context_prompt_tokens(summary, charts_path / "avg_prompt_tokens_by_context_format.png")
    _plot_context_total_tokens(summary, charts_path / "avg_total_tokens_by_context_format.png")
    _plot_context_total_tokens_per_success(summary, charts_path / "avg_total_tokens_per_success_by_context_format.png")
    _plot_context_success_rate(summary, charts_path / "success_rate_by_context_format.png")
    _plot_context_avg_score(summary, charts_path / "avg_score_by_context_format.png")


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


def _plot_context_prompt_tokens(summary: ContextRunSummary, out: Path) -> None:
    labels = list(summary["by_context_format"].keys())
    values = [_none_to_zero(summary["by_context_format"][label].get("avg_prompt_tokens")) for label in labels]
    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    ax.bar(labels, values, color=["#2563eb", "#10b981", "#f59e0b"][: len(labels)])
    ax.set_ylabel("avg prompt tokens")
    ax.set_title("Average Prompt Tokens by Context Format")
    ax.tick_params(axis="x", rotation=10)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_context_total_tokens(summary: ContextRunSummary, out: Path) -> None:
    labels = list(summary["by_context_format"].keys())
    values = [_none_to_zero(summary["by_context_format"][label].get("avg_total_tokens")) for label in labels]
    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    ax.bar(labels, values, color=["#0f766e", "#7c3aed", "#ea580c"][: len(labels)])
    ax.set_ylabel("avg total tokens")
    ax.set_title("Average Total Tokens by Context Format")
    ax.tick_params(axis="x", rotation=10)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_context_total_tokens_per_success(summary: ContextRunSummary, out: Path) -> None:
    labels = list(summary["by_context_format"].keys())
    values = [_none_to_zero(summary["by_context_format"][label].get("avg_total_tokens_per_success")) for label in labels]
    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    ax.bar(labels, values, color=["#1d4ed8", "#16a34a", "#d97706"][: len(labels)])
    ax.set_ylabel("avg total tokens / success")
    ax.set_title("Average Total Tokens per Successful Move")
    ax.tick_params(axis="x", rotation=10)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_context_success_rate(summary: ContextRunSummary, out: Path) -> None:
    labels = list(summary["by_context_format"].keys())
    values = [summary["by_context_format"][label]["success_rate"] for label in labels]
    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    ax.bar(labels, values, color=["#2563eb", "#14b8a6", "#f97316"][: len(labels)])
    ax.set_ylim(0, 100)
    ax.set_ylabel("% valid")
    ax.set_title("Success Rate by Context Format")
    ax.tick_params(axis="x", rotation=10)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _plot_context_avg_score(summary: ContextRunSummary, out: Path) -> None:
    labels = list(summary["by_context_format"].keys())
    values = [_none_to_zero(summary["by_context_format"][label].get("avg_score_valid")) for label in labels]
    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    ax.bar(labels, values, color=["#7c3aed", "#16a34a", "#ea580c"][: len(labels)])
    ax.set_ylabel("avg score on legal moves")
    ax.set_title("Average Score on Legal Moves")
    ax.tick_params(axis="x", rotation=10)
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


def _usage_prompt_tokens(usage: dict | None) -> int | None:
    if not usage:
        return None
    for key in ("prompt_tokens", "input_tokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return None


def _usage_total_tokens(usage: dict | None) -> int | None:
    if not usage:
        return None
    direct = usage.get("total_tokens")
    if isinstance(direct, (int, float)):
        return int(direct)
    prompt = _usage_prompt_tokens(usage)
    completion = usage.get("completion_tokens")
    if prompt is not None and isinstance(completion, (int, float)):
        reasoning = usage.get("reasoning_tokens")
        total = prompt + int(completion)
        if isinstance(reasoning, (int, float)):
            total += int(reasoning)
        return total
    output = usage.get("output_tokens")
    if prompt is not None and isinstance(output, (int, float)):
        return prompt + int(output)
    return None


def _none_to_zero(value: float | int | None) -> float:
    return float(value) if value is not None else 0.0
