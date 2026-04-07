# Scrabble Tool Calling Experiments

## Scope

This benchmark tests output techniques, not overall Scrabble strength.

Each case gives the model:
- a legal board
- a rack
- a target word
- a start position and direction

The model must place the word exactly.

## Techniques tested

### `placements_json`

Output only the new tiles:

```json
{
  "tool": "play_move",
  "arguments": {
    "placements": [
      { "row": 7, "col": 4, "letter": "M" }
    ]
  }
}
```

### `board_matrix_full`

Return the whole 15x15 board with canonical bonus tokens:
- `_`
- `2w`
- `3w`
- `2l`
- `3l`

### `delta_sparse`

Return only modified cells:

```json
{
  "tool": "play_delta",
  "arguments": {
    "cells": [
      { "row": 7, "col": 4, "value": "M" }
    ]
  }
}
```

### `line_slots`

Return a compact linear segment:
- uppercase letter = new tile
- `=` = existing crossing letter already on board

```json
{
  "tool": "play_line",
  "arguments": {
    "start_row": 7,
    "start_col": 4,
    "direction": "horizontal",
    "slots": ["M", "=", "N", "G", "E", "R"]
  }
}
```

## Important constraint

We explicitly avoided case-specific hints such as:
- exact overlap cells already on the board
- exact count of new tiles to emit

Those hints improve benchmark scores, but they help the model too much and stop measuring the output technique itself.

## What improved prompts without over-helping

The most useful prompt change was generic, not case-specific:
- explicitly say that `row` and `col` are 0-indexed
- explicitly say the game is in French
- explicitly say that existing crossing letters must not be re-emitted in sparse outputs
- include one generic worked example of a crossing word

This gave real gains, especially by reducing `overwrote_existing_tile`.

## Recurrent failure causes

Across providers and models, the dominant failures were:

### `overwrote_existing_tile`

The model often re-sent a crossing letter that was already on the board.

This was the single most important semantic error.

### `wrong_board_dimensions`

This mostly affected `board_matrix_full`.

Even when the model understood the task, it often failed to produce a strict 15x15 matrix.

### `missing_cells`

The model sometimes placed part of the word correctly but omitted one or more new tiles.

### `not_json`

Some models still returned commentary or malformed JSON instead of a single object.

### `provider_error`

Early OpenRouter runs were polluted by transport/provider issues rather than modeling errors.

## Provider lessons

### OpenRouter

OpenRouter was noticeably more stable after:
- adding `HTTP-Referer`
- adding `X-Title`
- retrying transient failures
- treating empty / malformed responses as retryable provider failures

Without that, benchmark results mixed real technique failures with transport noise.

### Local OpenAI-compatible backends

Local backends exposed two common non-model issues:
- context size exceeded
- long timeouts on larger models

Compact prompts mattered a lot there.

## Model-specific observations

### `qwen3.5-9b-claude-4.6-opus-reasoning-distilled`

Not useful in this setup for the benchmark:
- first blocked by context size
- then by repeated timeouts even after prompt compaction

### `qwen3.5-4b`

Fast enough to benchmark, but weak on exact placement:
- frequent `missing_cells`
- some `overwrote_existing_tile`
- no technique clearly strong

### `google/gemma-4-31b-it` via OpenRouter

This was the most useful model tested for comparing techniques.

Once provider handling was fixed, the benchmark reflected real output quality.

## Best runs we observed

### OpenRouter + `google/gemma-4-31b-it`

Run:
- `runtime-bench/scrabble-toolcall/runs/openrouter-gemma4-31b-it-18cases-retries2`

Result:
- `placements_json`: `66.7%` (`12/18`)
- `board_matrix_full`: `44.4%` (`8/18`)

Failure breakdown:
- `wrong_board_dimensions`: `8`
- `overwrote_existing_tile`: `5`
- `missing_cells`: `2`
- `not_json`: `1`

Key takeaway:
- once provider noise was reduced, `placements_json` clearly beat `board_matrix_full`

### OpenRouter + `google/gemma-4-31b-it` with generic overlap example

Run:
- `runtime-bench/scrabble-toolcall/runs/openrouter-gemma4-31b-it-overlap-example-limit6`

Result:
- `4/18` successes on a small exploratory run

Key takeaway:
- generic overlap examples help
- they reduced `overwrote_existing_tile`
- they do not require leaking the answer of the current case

### OpenRouter + `google/gemma-4-31b-it` with `line_slots`

Run:
- `runtime-bench/scrabble-toolcall/runs/openrouter-gemma4-31b-it-18cases-lineslots-v2`

This run was stopped early after the ranking became clear.

Partial result after `47` jobs:
- `placements_json`: `11` successes / `17` completed
- `board_matrix_full`: `7` successes / `14` completed
- `line_slots`: `6` successes / `16` completed

Key takeaway:
- `line_slots` is viable
- but it did not beat `placements_json`
- it still suffered from crossing mistakes and occasional payload mistakes

## What did not help enough

### Full board rewriting

`board_matrix_full` looked attractive because it is spatially explicit, but in practice:
- it is verbose
- it is brittle
- strict 15x15 compliance is hard for many models

### Over-constraining the case

Giving the model the exact overlap cells or the exact number of new tiles improves score, but stops being a fair comparison of tool-calling techniques.

### Cleverer compact spatial formats

`line_slots` was a good attempt, but for this benchmark it did not outperform `placements_json`.

## Current conclusion

For the main project, the practical default remains:

### Preferred action format

`placements_json`

Because it is:
- explicit
- compact
- easier to validate
- less brittle than full-board rewriting
- empirically the best performer in our OpenRouter/Gemma benchmark

## Main product lessons to reuse

These lessons are safe to carry into the web app:

1. Keep `play_move` as the primary placement interface.
2. State clearly that `play_move` must contain only newly placed tiles.
3. Add a generic crossing example to the system prompt.
4. Keep 0-indexing explicit everywhere.
5. Keep error messages explicit when a model overwrites an occupied cell.
6. Harden OpenRouter transport with headers and retries so provider noise does not masquerade as model failure.
