from __future__ import annotations

from .types import BenchmarkCase

RESET = "\033[0m"
DIM = "\033[2m"
GRAY = "\033[90m"
GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
YELLOW = "\033[93m"


def render_case_diff(case: BenchmarkCase, predicted_board: list[list[str]] | None) -> str:
    before = case["board_before"]
    expected = case["board_after"]
    lines: list[str] = []
    header = f"{CYAN}{case['case_id']}{RESET} {case['difficulty']} word={case['target_word']} rack={''.join(case['rack'])}"
    lines.append(header)
    lines.append("    " + " ".join(f"{index:>2}" for index in range(15)))
    for row in range(15):
        rendered: list[str] = []
        for col in range(15):
            base = before[row][col]
            expected_token = expected[row][col]
            predicted = predicted_board[row][col] if predicted_board is not None else None
            rendered.append(colorize_cell(base, expected_token, predicted))
        lines.append(f"{row:>2}  " + " ".join(rendered))
    return "\n".join(lines)


def colorize_cell(base: str, expected: str, predicted: str | None) -> str:
    if is_letter(base):
        if predicted is not None and predicted != base:
            return f"{RED}{predicted:>2}{RESET}"
        return f"{GRAY}{base:>2}{RESET}"

    if is_letter(expected):
        if predicted == expected:
            return f"{GREEN}{expected:>2}{RESET}"
        if predicted and predicted != expected:
            return f"{RED}{predicted:>2}{RESET}"
        return f"{RED}{expected:>2}{RESET}"

    if predicted and is_letter(predicted):
        return f"{RED}{predicted:>2}{RESET}"

    token = expected.lower()
    return f"{DIM}{token:>2}{RESET}"


def render_status_line(index: int, total: int, success_count: int, result: dict) -> str:
    marker = f"{GREEN}OK{RESET}" if result.get("success") else f"{RED}KO{RESET}"
    success_rate = (success_count / index * 100) if index else 0.0
    cause = f" cause={result.get('failure_cause')}" if not result.get("success") else ""
    return (
        f"[{index:>4}/{total}] {marker} "
        f"model={result.get('model')} technique={result.get('technique')} "
        f"context={result.get('context_format', '-')} case={result.get('case_id')} "
        f"latency={result.get('latency_ms')}ms valid={success_rate:5.1f}%{cause}"
    )


def render_summary_text(summary: dict) -> str:
    lines = [
        f"Provider: {summary['provider']}",
        f"Models: {', '.join(summary['models'])}",
        f"Dataset: {summary['dataset_path']}",
        "Validite par technique:",
    ]
    for technique, data in summary["by_technique"].items():
        lines.append(f"  - {technique}: {data['success_rate']:.1f}% ({data['success']}/{data['total']})")
    lines.append("Causes d'echec:")
    for cause, count in sorted(summary["failure_breakdown"].items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"  - {cause}: {count}")
    return "\n".join(lines)


def render_context_summary_text(summary: dict) -> str:
    lines = [
        f"Provider: {summary['provider']}",
        f"Models: {', '.join(summary['models'])}",
        f"Dataset: {summary['dataset_path']}",
        "Context format results:",
    ]
    for context_format, data in summary["by_context_format"].items():
        prompt_tokens = data.get("avg_prompt_tokens")
        total_tokens = data.get("avg_total_tokens")
        per_success = data.get("avg_total_tokens_per_success")
        avg_score = data.get("avg_score_valid")
        lines.append(
            "  - "
            f"{context_format}: valid={data['success_rate']:.1f}% ({data['success']}/{data['total']}), "
            f"avg_score_valid={avg_score if avg_score is not None else 'n/a'}, "
            f"avg_prompt_tokens={prompt_tokens if prompt_tokens is not None else 'n/a'}, "
            f"avg_total_tokens={total_tokens if total_tokens is not None else 'n/a'}, "
            f"avg_total_tokens_per_success={per_success if per_success is not None else 'n/a'}"
        )
    return "\n".join(lines)


def is_letter(token: str) -> bool:
    return len(token) == 1 and token.isalpha() and token.upper() == token
