from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import time
from pathlib import Path

import requests

from .concurrency import run_jobs_concurrently
from .dataset import append_jsonl, generate_dataset_via_ts, load_dataset
from .evaluator import EvaluationOutcome, evaluate_raw_response
from .prompts import build_prompt
from .providers import GoogleGenerativeAIClient, OpenAICompatibleClient, ProviderError
from .render_terminal import render_case_diff, render_status_line, render_summary_text
from .reporting import render_charts, summarize_results, write_summary
from .techniques import normalize_techniques
from .types import BenchmarkCase, BenchmarkJob, ProviderName, TechniqueResult


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
    generate.add_argument("--dictionary", default="public/dictionary/en-large.txt")

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
        "success": evaluation.success,
        "failure_cause": evaluation.failure_cause,
        "raw_response": raw_response,
        "parsed_payload": evaluation.parsed_payload,
        "latency_ms": latency_ms,
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
        "success": False,
        "failure_cause": cause,  # type: ignore[typeddict-item]
        "raw_response": raw_response or "",
        "parsed_payload": None,
        "latency_ms": 0,
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


if __name__ == "__main__":
    main()
