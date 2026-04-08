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
  --out runtime-bench/scrabble-toolcall/datasets/default-500.jsonl
```

Default dictionary:
- `public/dictionary/en-large.txt`

## Run a local OpenAI-compatible benchmark

```bash
python3 -m benchmarks.scrabble_toolcall.cli run \
  --provider openai_compatible \
  --base-url http://127.0.0.1:1234/v1/chat/completions \
  --model qwen3.5-4b \
  --dataset runtime-bench/scrabble-toolcall/datasets/default-500.jsonl \
  --techniques placements_json board_matrix_full delta_sparse \
  --concurrency 5 \
  --out runtime-bench/scrabble-toolcall/runs/local-qwen35
```

## Generate a report

```bash
python3 -m benchmarks.scrabble_toolcall.cli report \
  --run runtime-bench/scrabble-toolcall/runs/local-qwen35
```

## Notes

- concurrency is capped at `5`
- board diffs are shown by default only on failures
- charts are written to `charts/`
