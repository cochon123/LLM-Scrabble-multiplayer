You are optimizing the Scrabble toolcall benchmark in this repository.

Goal:
- maximize the scalar score produced by:
  - `python3 autoresearch/scrabble_toolcall/train.py`

Do not optimize the game itself. Optimize the protocol.

What matters:
- the benchmark score
- especially success rate
- especially reducing `overwrote_existing_tile`
- while keeping the benchmark honest

Editable files only:
- `benchmarks/scrabble_toolcall/prompts.py`
- `benchmarks/scrabble_toolcall/techniques.py`
- `benchmarks/scrabble_toolcall/types.py`
- `benchmarks/scrabble_toolcall/evaluator.py`
- `benchmarks/scrabble_toolcall/tests/test_evaluator.py`
- `autoresearch/scrabble_toolcall/techniques.txt`

Do not edit:
- anything else under `autoresearch/scrabble_toolcall/`
- generated dataset files
- benchmark run outputs
- unrelated webapp files

Hard constraints:
- do not hardcode case ids, board answers, or target words
- do not edit the scoring logic
- do not change the model, provider endpoint, timeout, concurrency, retries, or temperature
- do not make the evaluator more permissive in a way that accepts incorrect boards
- every protocol must still resolve to exact tile placements and exact final board reconstruction

Benchmark configuration is fixed:
- model: `deepseek/deepseek-v3.2`
- transport: OpenRouter
- timeout: `250s`
- concurrency: `5`
- search dataset: `10 simple + 10 medium + 10 hard`
- holdout dataset: `10 simple + 10 medium + 10 hard`

Optimization strategy:
1. Inspect current techniques and failure modes.
2. Make one focused change at a time.
3. Run `python3 autoresearch/scrabble_toolcall/train.py`.
4. Compare the new score against the previous best.
5. Keep changes only if they improve the score or reveal a promising new direction.
6. Occasionally validate with `python3 autoresearch/scrabble_toolcall/eval_holdout.py`.

You are allowed to invent new tool interfaces.
You are not limited to the current built-in techniques.

If you introduce a new technique:
- add its name to `autoresearch/scrabble_toolcall/techniques.txt`
- add prompt support
- add evaluator support
- keep the output JSON-based and mechanically decodable

Preferred search directions:
- better handling of crossing letters already on the board
- interfaces that reduce overwrite mistakes
- board encodings that make occupied-vs-new cells unambiguous
- output schemas that keep coordinates exact but reduce cognitive load
- better few-shot examples

Avoid:
- broad rewrites
- multiple unrelated changes in one step
- editing the harness
- overfitting obvious special cases from a single run

Success criterion:
- improve the scalar score from `train.py`
- then confirm the improvement on `eval_holdout.py`
