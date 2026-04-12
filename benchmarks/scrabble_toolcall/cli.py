from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import subprocess
import time
from pathlib import Path

import requests

from .concurrency import run_jobs_concurrently
from .dataset import append_jsonl, generate_dataset_via_ts, load_dataset
from .evaluator import EvaluationOutcome, evaluate_raw_response, parse_json_payload
from .prompts import build_free_play_prompt_for_context_format, build_prompt, build_prompt_for_context_format
from .providers import GoogleGenerativeAIClient, OpenAICompatibleClient, ProviderError
from .render_terminal import render_case_diff, render_context_summary_text, render_status_line, render_summary_text
from .reporting import render_charts, render_context_charts, summarize_context_results, summarize_results, write_summary
from .techniques import normalize_techniques
from .types import BenchmarkCase, BenchmarkJob, ContextFormatName, ProviderName, TechniqueResult


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="scrabble-toolcall-bench")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate-dataset")
    generate.add_argument("--count", type=int, default=500)
    generate.add_argument("--simple", type=int, default=200)
    generate.add_argument("--medium", type=int, default=200)
    generate.add_argument("--hard", type=int, default=100)
    generate.add_argument("--out", required=True)
    generate.add_argument("--seed", type=int, default=1)
    generate.add_argument("--dictionary", default="public/dictionary/en_large.txt")

    run = subparsers.add_parser("run")
    run.add_argument("--provider", choices=["openai_compatible", "google"], default="openai_compatible")
    run.add_argument("--base-url")
    run.add_argument("--model", action="append", required=True)
    run.add_argument("--api-key")
    run.add_argument("--api-key-env")
    run.add_argument("--dataset", required=True)
    run.add_argument("--techniques", nargs="+", default=["placements_json", "board_matrix_full", "delta_sparse"])
    run.add_argument("--out", required=True)
    run.add_argument("--limit", type=int)
    run.add_argument("--seed", type=int, default=1)
    run.add_argument("--temperature", type=float, default=0.0)
    run.add_argument("--timeout-seconds", type=int, default=60)
    run.add_argument("--concurrency", type=int, default=5)
    run.add_argument("--retries", type=int, default=0)
    run.add_argument("--resume", action="store_true")
    run.add_argument("--show-all-cases", action="store_true")
    run.add_argument("--failures-only", action="store_true")

    context_run = subparsers.add_parser("run-context-benchmark")
    context_run.add_argument("--provider", choices=["openai_compatible", "google"], default="openai_compatible")
    context_run.add_argument("--base-url")
    context_run.add_argument("--model", action="append", required=True)
    context_run.add_argument("--api-key")
    context_run.add_argument("--api-key-env")
    context_run.add_argument("--dataset", required=True)
    context_run.add_argument("--techniques", nargs="+", default=["placements_json"])
    context_run.add_argument("--context-formats", nargs="+", default=["summary_delta", "board_2d_full"])
    context_run.add_argument("--out", required=True)
    context_run.add_argument("--limit", type=int)
    context_run.add_argument("--seed", type=int, default=1)
    context_run.add_argument("--temperature", type=float, default=0.0)
    context_run.add_argument("--timeout-seconds", type=int, default=60)
    context_run.add_argument("--concurrency", type=int, default=5)
    context_run.add_argument("--retries", type=int, default=0)
    context_run.add_argument("--resume", action="store_true")
    context_run.add_argument("--show-all-cases", action="store_true")
    context_run.add_argument("--failures-only", action="store_true")

    free_play_run = subparsers.add_parser("run-free-play-context-benchmark")
    free_play_run.add_argument("--provider", choices=["openai_compatible", "google"], default="openai_compatible")
    free_play_run.add_argument("--base-url")
    free_play_run.add_argument("--model", action="append", required=True)
    free_play_run.add_argument("--api-key")
    free_play_run.add_argument("--api-key-env")
    free_play_run.add_argument("--dataset", required=True)
    free_play_run.add_argument("--context-formats", nargs="+", default=["summary_delta", "summary_delta_plus_2d_full"])
    free_play_run.add_argument("--out", required=True)
    free_play_run.add_argument("--limit", type=int)
    free_play_run.add_argument("--seed", type=int, default=1)
    free_play_run.add_argument("--temperature", type=float, default=0.0)
    free_play_run.add_argument("--timeout-seconds", type=int, default=60)
    free_play_run.add_argument("--concurrency", type=int, default=5)
    free_play_run.add_argument("--retries", type=int, default=0)
    free_play_run.add_argument("--resume", action="store_true")
    free_play_run.add_argument("--show-all-cases", action="store_true")
    free_play_run.add_argument("--failures-only", action="store_true")
    free_play_run.add_argument("--dictionary", default="public/dictionary/en_large.txt")

    report = subparsers.add_parser("report")
    report.add_argument("--run", required=True)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "generate-dataset":
        generate_dataset_via_ts(
            out=args.out,
            count=args.count,
            simple=args.simple,
            medium=args.medium,
            hard=args.hard,
            seed=args.seed,
            dictionary=args.dictionary,
        )
        print(json.dumps({"ok": True, "out": args.out, "count": args.count}))
        return

    if args.command == "run":
        asyncio.run(run_benchmark(args))
        return

    if args.command == "run-context-benchmark":
        asyncio.run(run_context_benchmark(args))
        return

    if args.command == "run-free-play-context-benchmark":
        asyncio.run(run_free_play_context_benchmark(args))
        return

    if args.command == "report":
        report_run(args.run)
        return


async def run_benchmark(args: argparse.Namespace) -> None:
    provider: ProviderName = args.provider
    techniques = normalize_techniques(args.techniques)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_results_path = output_dir / "raw_results.jsonl"

    cases = load_dataset(args.dataset)
    rng = random.Random(args.seed)
    rng.shuffle(cases)
    if args.limit:
        cases = cases[: args.limit]

    models: list[str] = args.model
    jobs: list[BenchmarkJob] = []
    total = len(cases) * len(techniques) * len(models)
    index = 0
    existing_keys = load_existing_keys(raw_results_path) if args.resume else set()
    for case in cases:
        for technique in techniques:
            for model in models:
                index += 1
                key = (case["case_id"], technique, model)
                if key in existing_keys:
                    continue
                jobs.append(
                    {
                        "case_id": case["case_id"],
                        "technique": technique,
                        "context_format": "summary_delta",
                        "model": model,
                        "provider": provider,
                        "prompt": build_prompt(case, technique),
                        "case": case,
                        "index": index,
                        "total": total,
                    }
                )

    api_key = args.api_key
    if not api_key and args.api_key_env:
        api_key = os.environ.get(args.api_key_env)

    if provider == "google":
        if not api_key:
            raise SystemExit("Google provider requires --api-key or --api-key-env.")
        client = GoogleGenerativeAIClient(api_key=api_key, base_url=args.base_url, timeout_seconds=args.timeout_seconds)
    else:
        if not args.base_url:
            raise SystemExit("openai_compatible provider requires --base-url.")
        client = OpenAICompatibleClient(args.base_url, api_key=api_key, timeout_seconds=args.timeout_seconds)
    results: list[TechniqueResult] = []
    success_count = 0

    async def worker(job: BenchmarkJob) -> TechniqueResult:
        return await asyncio.to_thread(execute_job, client, job, args.temperature, args.retries)

    def on_result(result: TechniqueResult) -> None:
        nonlocal success_count
        results.append(result)
        if result["success"]:
            success_count += 1
        append_jsonl(raw_results_path, result)
        print(render_status_line(len(results), len(jobs), success_count, result))
        if args.show_all_cases or (not result["success"]):
            print(render_case_diff(result["case"], result.get("predicted_board")))  # type: ignore[index]
            if result.get("details"):
                print(f"detail: {result['details']}")

    await run_jobs_concurrently(jobs, min(args.concurrency, 5), worker, on_result=on_result)

    all_results = load_raw_results(raw_results_path)
    summary = summarize_results(all_results, provider, models, args.dataset, techniques)
    write_summary(output_dir / "summary.json", summary)
    render_charts(summary, output_dir / "charts")
    print()
    print(render_summary_text(summary))


async def run_context_benchmark(args: argparse.Namespace) -> None:
    provider: ProviderName = args.provider
    techniques = normalize_techniques(args.techniques)
    context_formats = normalize_context_formats(args.context_formats)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_results_path = output_dir / "raw_results.jsonl"

    cases = load_dataset(args.dataset)
    rng = random.Random(args.seed)
    rng.shuffle(cases)
    if args.limit:
        cases = cases[: args.limit]

    models: list[str] = args.model
    jobs: list[BenchmarkJob] = []
    total = len(cases) * len(techniques) * len(context_formats) * len(models)
    index = 0
    existing_keys = load_existing_context_keys(raw_results_path) if args.resume else set()
    for case in cases:
        for technique in techniques:
            for context_format in context_formats:
                for model in models:
                    index += 1
                    key = (case["case_id"], technique, context_format, model)
                    if key in existing_keys:
                        continue
                    jobs.append(
                        {
                            "case_id": case["case_id"],
                            "technique": technique,
                            "context_format": context_format,
                            "model": model,
                            "provider": provider,
                            "prompt": build_prompt_for_context_format(case, technique, context_format),
                            "case": case,
                            "index": index,
                            "total": total,
                        }
                    )

    api_key = args.api_key
    if not api_key and args.api_key_env:
        api_key = os.environ.get(args.api_key_env)

    if provider == "google":
        if not api_key:
            raise SystemExit("Google provider requires --api-key or --api-key-env.")
        client = GoogleGenerativeAIClient(api_key=api_key, base_url=args.base_url, timeout_seconds=args.timeout_seconds)
    else:
        if not args.base_url:
            raise SystemExit("openai_compatible provider requires --base-url.")
        client = OpenAICompatibleClient(args.base_url, api_key=api_key, timeout_seconds=args.timeout_seconds)
    results: list[TechniqueResult] = []
    success_count = 0

    async def worker(job: BenchmarkJob) -> TechniqueResult:
        return await asyncio.to_thread(execute_job, client, job, args.temperature, args.retries)

    def on_result(result: TechniqueResult) -> None:
        nonlocal success_count
        results.append(result)
        if result["success"]:
            success_count += 1
        append_jsonl(raw_results_path, result)
        print(render_status_line(len(results), len(jobs), success_count, result))
        if args.show_all_cases or (not result["success"]):
            print(render_case_diff(result["case"], result.get("predicted_board")))  # type: ignore[index]
            if result.get("details"):
                print(f"detail: {result['details']}")

    await run_jobs_concurrently(jobs, min(args.concurrency, 5), worker, on_result=on_result)

    all_results = load_raw_results(raw_results_path)
    summary = summarize_context_results(all_results, provider, models, args.dataset, techniques, context_formats)
    write_summary(output_dir / "summary.json", summary)
    render_context_charts(summary, output_dir / "charts")
    print()
    print(render_context_summary_text(summary))


async def run_free_play_context_benchmark(args: argparse.Namespace) -> None:
    provider: ProviderName = args.provider
    context_formats = normalize_context_formats(args.context_formats)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_results_path = output_dir / "raw_results.jsonl"

    cases = load_dataset(args.dataset)
    rng = random.Random(args.seed)
    rng.shuffle(cases)
    if args.limit:
        cases = cases[: args.limit]

    models: list[str] = args.model
    jobs: list[BenchmarkJob] = []
    total = len(cases) * len(context_formats) * len(models)
    index = 0
    existing_keys = load_existing_context_keys(raw_results_path) if args.resume else set()
    for case in cases:
        for context_format in context_formats:
            for model in models:
                index += 1
                key = (case["case_id"], "placements_json", context_format, model)
                if key in existing_keys:
                    continue
                jobs.append(
                    {
                        "case_id": case["case_id"],
                        "technique": "placements_json",
                        "context_format": context_format,
                        "model": model,
                        "provider": provider,
                        "prompt": build_free_play_prompt_for_context_format(case, context_format),
                        "case": case,
                        "index": index,
                        "total": total,
                    }
                )

    api_key = args.api_key
    if not api_key and args.api_key_env:
        api_key = os.environ.get(args.api_key_env)

    if provider == "google":
        if not api_key:
            raise SystemExit("Google provider requires --api-key or --api-key-env.")
        client = GoogleGenerativeAIClient(api_key=api_key, base_url=args.base_url, timeout_seconds=args.timeout_seconds)
    else:
        if not args.base_url:
            raise SystemExit("openai_compatible provider requires --base-url.")
        client = OpenAICompatibleClient(args.base_url, api_key=api_key, timeout_seconds=args.timeout_seconds)
    results: list[TechniqueResult] = []
    success_count = 0

    async def worker(job: BenchmarkJob) -> TechniqueResult:
        return await asyncio.to_thread(execute_free_play_job, client, job, args.temperature, args.retries, args.dictionary)

    def on_result(result: TechniqueResult) -> None:
        nonlocal success_count
        results.append(result)
        if result["success"]:
            success_count += 1
        append_jsonl(raw_results_path, result)
        print(render_status_line(len(results), len(jobs), success_count, result))
        if args.show_all_cases or (not result["success"]):
            print(render_case_diff(result["case"], result.get("predicted_board")))  # type: ignore[index]
            if result.get("details"):
                print(f"detail: {result['details']}")

    await run_jobs_concurrently(jobs, min(args.concurrency, 5), worker, on_result=on_result)

    all_results = load_raw_results(raw_results_path)
    summary = summarize_context_results(all_results, provider, models, args.dataset, ["placements_json"], context_formats)
    write_summary(output_dir / "summary.json", summary)
    render_context_charts(summary, output_dir / "charts")
    print()
    print(render_context_summary_text(summary))


def execute_job(
    client: OpenAICompatibleClient,
    job: BenchmarkJob,
    temperature: float,
    retries: int,
) -> TechniqueResult:
    attempts = retries + 1
    last_result: TechniqueResult | None = None
    for attempt in range(attempts):
        try:
            provider_response = client.complete(job["model"], job["prompt"], temperature=temperature)
            evaluation = evaluate_raw_response(job["case"], job["technique"], provider_response.raw_text)
            return build_result(job, provider_response.raw_text, provider_response.latency_ms, provider_response.usage, evaluation)
        except requests.Timeout:
            last_result = build_error_result(job, "timeout", None, f"Timeout apres {attempt + 1} tentative(s).")
        except ProviderError as error:
            last_result = build_error_result(job, "provider_error", None, str(error))
            if attempt + 1 < attempts and error.retryable:
                time.sleep(min(6.0, 1.25 * (attempt + 1)))
                continue
            return last_result
        if last_result is not None and attempt + 1 < attempts:
            time.sleep(min(6.0, 1.25 * (attempt + 1)))
    if last_result is None:
        last_result = build_error_result(job, "provider_error", None, "Erreur inconnue.")
    return last_result


def execute_free_play_job(
    client: OpenAICompatibleClient,
    job: BenchmarkJob,
    temperature: float,
    retries: int,
    dictionary_path: str,
) -> TechniqueResult:
    attempts = retries + 1
    last_result: TechniqueResult | None = None
    for attempt in range(attempts):
        try:
            provider_response = client.complete(job["model"], job["prompt"], temperature=temperature)
            evaluation = evaluate_free_play_response(job["case"], provider_response.raw_text, dictionary_path)
            return build_result(job, provider_response.raw_text, provider_response.latency_ms, provider_response.usage, evaluation)
        except requests.Timeout:
            last_result = build_error_result(job, "timeout", None, f"Timeout apres {attempt + 1} tentative(s).")
        except ProviderError as error:
            last_result = build_error_result(job, "provider_error", None, str(error))
            if attempt + 1 < attempts and error.retryable:
                time.sleep(min(6.0, 1.25 * (attempt + 1)))
                continue
            return last_result
        if last_result is not None and attempt + 1 < attempts:
            time.sleep(min(6.0, 1.25 * (attempt + 1)))
    if last_result is None:
        last_result = build_error_result(job, "provider_error", None, "Erreur inconnue.")
    return last_result


def build_result(
    job: BenchmarkJob,
    raw_response: str,
    latency_ms: int,
    usage: dict | None,
    evaluation: EvaluationOutcome,
) -> TechniqueResult:
    return {
        "case_id": job["case_id"],
        "difficulty": job["case"]["difficulty"],
        "provider": job["provider"],
        "model": job["model"],
        "technique": job["technique"],
        "context_format": job["context_format"],
        "success": evaluation.success,
        "failure_cause": evaluation.failure_cause,
        "raw_response": raw_response,
        "parsed_payload": evaluation.parsed_payload,
        "latency_ms": latency_ms,
        "move_score": getattr(evaluation, "move_score", None),
        "predicted_board": evaluation.predicted_board,
        "details": evaluation.details,
        "usage": usage,
        "job_index": job["index"],
        "total_jobs": job["total"],
        "case": job["case"],
    }  # type: ignore[return-value]


def build_error_result(job: BenchmarkJob, cause: str, raw_response: str | None, details: str | None) -> TechniqueResult:
    return {
        "case_id": job["case_id"],
        "difficulty": job["case"]["difficulty"],
        "provider": job["provider"],
        "model": job["model"],
        "technique": job["technique"],
        "context_format": job["context_format"],
        "success": False,
        "failure_cause": cause,  # type: ignore[typeddict-item]
        "raw_response": raw_response or "",
        "parsed_payload": None,
        "latency_ms": 0,
        "move_score": None,
        "predicted_board": None,
        "details": details,
        "usage": None,
        "job_index": job["index"],
        "total_jobs": job["total"],
        "case": job["case"],
    }  # type: ignore[return-value]


def load_existing_keys(path: Path) -> set[tuple[str, str, str]]:
    if not path.exists():
        return set()
    keys: set[tuple[str, str, str]] = set()
    for line in path.read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        keys.add((item["case_id"], item["technique"], item["model"]))
    return keys


def load_existing_context_keys(path: Path) -> set[tuple[str, str, str, str]]:
    if not path.exists():
        return set()
    keys: set[tuple[str, str, str, str]] = set()
    for line in path.read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        keys.add((item["case_id"], item["technique"], item.get("context_format", "summary_delta"), item["model"]))
    return keys


def load_raw_results(path: Path) -> list[TechniqueResult]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]


def report_run(run_dir: str) -> None:
    run_path = Path(run_dir)
    raw_results = [
        json.loads(line)
        for line in (run_path / "raw_results.jsonl").read_text(encoding="utf8").splitlines()
        if line.strip()
    ]
    if raw_results and any("context_format" in item for item in raw_results):
        summary = summarize_context_results(
            raw_results,
            raw_results[0]["provider"] if raw_results else "openai_compatible",
            sorted({item["model"] for item in raw_results}),
            str(run_path),
            sorted({item["technique"] for item in raw_results}),
            sorted({item.get("context_format", "summary_delta") for item in raw_results}),
        )
        write_summary(run_path / "summary.json", summary)
        render_context_charts(summary, run_path / "charts")
        print(render_context_summary_text(summary))
        return
    summary = summarize_results(
        raw_results,
        raw_results[0]["provider"] if raw_results else "openai_compatible",
        sorted({item["model"] for item in raw_results}),
        str(run_path),
        sorted({item["technique"] for item in raw_results}),
    )
    write_summary(run_path / "summary.json", summary)
    render_charts(summary, run_path / "charts")
    print(render_summary_text(summary))


def normalize_context_formats(values: list[str]) -> list[ContextFormatName]:
    supported: tuple[ContextFormatName, ...] = (
        "summary_delta",
        "summary_delta_plus_2d_full",
        "board_2d_full",
        "board_2d_compact",
    )
    normalized: list[ContextFormatName] = []
    for value in values:
        if value not in supported:
            raise ValueError(f"Unknown context format: {value}")
        normalized.append(value)  # type: ignore[arg-type]
    return normalized


def evaluate_free_play_response(case: BenchmarkCase, raw_response: str, dictionary_path: str) -> EvaluationOutcome:
    if not raw_response.strip():
        return EvaluationOutcome(False, "no_response", None, None, "Reponse vide.")

    payload = parse_json_payload(raw_response)
    if payload is None:
        return EvaluationOutcome(False, "not_json", None, None, "Objet JSON introuvable.")
    if not isinstance(payload, dict):
        return EvaluationOutcome(False, "wrong_top_level_shape", None, None, "Le niveau racine doit etre un objet.")
    if payload.get("tool") != "play_move":
        return EvaluationOutcome(False, "wrong_tool_name", payload, None, "Outil attendu: play_move.")
    arguments = payload.get("arguments")
    if not isinstance(arguments, dict):
        return EvaluationOutcome(False, "wrong_top_level_shape", payload, None, "Champ arguments manquant ou invalide.")
    placements = arguments.get("placements")
    if not isinstance(placements, list):
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "placements doit etre une liste.")

    normalized: list[dict[str, object]] = []
    for item in placements:
        if not isinstance(item, dict):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Chaque placement doit etre un objet.")
        row = item.get("row")
        col = item.get("col")
        letter = item.get("letter")
        if not isinstance(row, int) or not isinstance(col, int) or not isinstance(letter, str):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Cellule mal formee.")
        normalized.append({"row": row, "col": col, "letter": letter})

    command = [
        "npx",
        "tsx",
        "src/bench/engine_cli.ts",
        "evaluate-free-play",
        "--dictionary",
        dictionary_path,
    ]
    completed = subprocess.run(
        command,
        input=json.dumps({"case": case, "placements": normalized}),
        text=True,
        capture_output=True,
        cwd=Path(__file__).resolve().parents[2],
        check=False,
    )
    if completed.returncode != 0:
        details = completed.stderr.strip() or completed.stdout.strip() or "TS free-play evaluator failed."
        return EvaluationOutcome(False, "provider_error", payload, None, details)
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return EvaluationOutcome(False, "provider_error", payload, None, "TS free-play evaluator returned invalid JSON.")

    outcome = EvaluationOutcome(
        bool(result.get("success")),
        None if result.get("success") else "illegal_move",
        payload,
        result.get("predicted_board"),
        result.get("summary") if result.get("success") else result.get("error"),
    )
    outcome.move_score = result.get("score") if isinstance(result.get("score"), int) else None  # type: ignore[attr-defined]
    return outcome


if __name__ == "__main__":
    main()
