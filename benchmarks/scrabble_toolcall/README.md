# Scrabble Tool-Call Benchmark

Python CLI for comparing structured output techniques on a guided Scrabble placement task.

## What V1 measures

- given board
- given rack
- given target word
- the model must return the exact letter positions

The benchmark measures output-technique accuracy, not general Scrabble strategy.

## Techniques

- `placements_json`
- `board_matrix_full`
- `delta_sparse`
- `line_slots`

## Generate a dataset

```bash
python3 -m benchmarks.scrabble_toolcall.cli generate-dataset \
  --count 500 \
  --simple 200 \
  --medium 200 \
  --hard 100 \
  --out var/bench/scrabble_toolcall/datasets/default_500.jsonl
```

Default dictionary:
- `public/dictionary/en_large.txt`

## Run a local OpenAI-compatible benchmark

```bash
python3 -m benchmarks.scrabble_toolcall.cli run \
  --provider openai_compatible \
  --base-url http://127.0.0.1:1234/v1/chat/completions \
  --model qwen3.5-4b \
  --dataset var/bench/scrabble_toolcall/datasets/default_500.jsonl \
  --techniques placements_json board_matrix_full delta_sparse \
  --concurrency 5 \
  --out var/bench/scrabble_toolcall/runs/local_qwen35
```

## Generate a report

```bash
python3 -m benchmarks.scrabble_toolcall.cli report \
  --run var/bench/scrabble_toolcall/runs/local_qwen35
```

## Run a context-format benchmark

```bash
python3 -m benchmarks.scrabble_toolcall.cli run-context-benchmark \
  --provider openai_compatible \
  --base-url http://127.0.0.1:1234/v1/chat/completions \
  --model qwen3.5-4b \
  --dataset var/bench/scrabble_toolcall/datasets/autoresearch_search_30.jsonl \
  --techniques placements_json \
  --context-formats summary_delta board_2d_full board_2d_compact \
  --concurrency 5 \
  --timeout-seconds 60 \
  --out var/bench/scrabble_toolcall/runs/context_qwen35
```

This mode holds the task and evaluator constant and changes only the board/context encoding. It reports:

- average prompt tokens
- average total tokens
- average total tokens per successful move
- success rate by context format

## Run a free-play context-format benchmark

This mode does not give the model a target word. The model sees the board and rack, must find its own legal move, and the returned placements are validated by the real TypeScript Scrabble engine.

```bash
python3 -m benchmarks.scrabble_toolcall.cli run-free-play-context-benchmark \
  --provider openai_compatible \
  --base-url https://openrouter.ai/api/v1/chat/completions \
  --model deepseek/deepseek-v3.2 \
  --dataset var/bench/scrabble_toolcall/datasets/autoresearch_hard_10.jsonl \
  --context-formats summary_delta summary_delta_plus_2d_full \
  --concurrency 5 \
  --timeout-seconds 250 \
  --api-key-env OPENROUTER_API_KEY \
  --out var/bench/scrabble_toolcall/runs/deepseek_v32_hard10_freeplay
```

This reports:

- legal move rate
- average score on legal moves
- average prompt tokens
- average total tokens
- average total tokens per legal move

## Notes

- concurrency is capped at `5`
- board diffs are shown by default only on failures
- charts are written to `charts/`
