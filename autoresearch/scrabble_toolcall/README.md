# Scrabble Toolcall Autoresearch

This folder is a fixed harness for running `karpathy/autoresearch` against the
Scrabble toolcall benchmark in this repo.

The optimization target is:
- improve the benchmark score
- by changing prompt design and/or tool interface design
- while keeping the evaluator honest

## Fixed benchmark settings

- model: `deepseek/deepseek-v3.2`
- transport: OpenRouter through the existing `openai_compatible` benchmark client
- timeout: `250` seconds
- concurrency: `5`
- retries: `2`
- temperature: `0`
- search dataset: `10 simple + 10 medium + 10 hard`
- holdout dataset: `10 simple + 10 medium + 10 hard`

## What is fixed

These files are part of the harness and should not be edited by the research
agent:

- [prepare.py](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/prepare.py)
- [train.py](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/train.py)
- [eval_holdout.py](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/eval_holdout.py)
- [score_run.py](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/score_run.py)
- [README.md](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/README.md)
- [program.md](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/program.md)

The generated datasets are also fixed once created:

- `runtime-bench/scrabble-toolcall/datasets/autoresearch-search-30.jsonl`
- `runtime-bench/scrabble-toolcall/datasets/autoresearch-holdout-30.jsonl`

## What the research agent may edit

The editable search space is intentionally limited to prompt and protocol
design:

- [prompts.py](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall/prompts.py)
- [techniques.py](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall/techniques.py)
- [types.py](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall/types.py)
- [evaluator.py](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall/evaluator.py)
- [test_evaluator.py](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall/tests/test_evaluator.py)
- [techniques.txt](/home/cochon/Documents/miniproject/scrabble_codex/autoresearch/scrabble_toolcall/techniques.txt)

This means the agent is allowed to:
- add a new tool protocol
- change the shape of a tool payload
- change the board representation
- change the prompt and few-shot examples
- add support code needed to decode and evaluate a new protocol

This means the agent is not allowed to:
- change the datasets
- hardcode case ids or answers
- change the score formula
- change the OpenRouter model, timeout, concurrency, retries, or temperature
- change the benchmark harness to make scoring easier

## Score

Each active technique gets its own weighted score:

```text
technique_score =
  100 * success_rate
  - 35 * overwrote_existing_tile_rate
  - 15 * not_json_rate
  - 10 * out_of_bounds_rate
  - 5 * missing_cells_rate
```

The run score is:

```text
run_score = max(technique_score across active techniques)
```

This lets the research agent introduce a new protocol without being forced to
keep legacy protocols equally strong.

## One-time setup

Do not commit secrets. Export the OpenRouter key in your shell:

```bash
export OPENROUTER_API_KEY='...'
```

Create the fixed search and holdout datasets:

```bash
python3 autoresearch/scrabble_toolcall/prepare.py
```

## Search loop

Run the optimization benchmark:

```bash
python3 autoresearch/scrabble_toolcall/train.py
```

Evaluate the current code on the holdout dataset:

```bash
python3 autoresearch/scrabble_toolcall/eval_holdout.py
```

## Notes

- `train.py` prints a JSON summary with the scalar score and the best technique.
- `eval_holdout.py` uses the same score formula, but on the holdout dataset.
- `techniques.txt` controls which techniques are benchmarked.
- If the agent invents a new protocol, it must also add prompt and evaluator
  support for that protocol.
