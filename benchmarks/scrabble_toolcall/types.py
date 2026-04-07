from __future__ import annotations

from typing import Any, Literal, TypedDict

Difficulty = Literal["simple", "medium", "hard"]
TechniqueName = Literal["placements_json", "board_matrix_full", "delta_sparse", "line_slots"]
ProviderName = Literal["openai_compatible", "google"]
FailureCause = Literal[
    "no_response",
    "provider_error",
    "timeout",
    "not_json",
    "wrong_top_level_shape",
    "wrong_tool_name",
    "wrong_board_dimensions",
    "invalid_board_token",
    "missing_cells",
    "extra_cells",
    "duplicate_coordinates",
    "out_of_bounds",
    "overwrote_existing_tile",
    "modified_unrelated_existing_tile",
    "used_letter_not_in_rack",
    "wrong_letter_at_coordinate",
    "target_word_not_realized",
    "board_after_mismatch",
    "technique_specific_invalid_payload",
]


class BenchmarkExpectedCell(TypedDict):
    row: int
    col: int
    letter: str


class BenchmarkCase(TypedDict):
    case_id: str
    difficulty: Difficulty
    provider_prompt_language: Literal["fr"]
    board_before: list[list[str]]
    board_after: list[list[str]]
    rack: list[str]
    target_word: str
    expected_move: dict[str, Any]
    metadata: dict[str, Any]


class BenchmarkJob(TypedDict):
    case_id: str
    technique: TechniqueName
    model: str
    provider: ProviderName
    prompt: str
    case: BenchmarkCase
    index: int
    total: int


class TechniqueResult(TypedDict, total=False):
    case_id: str
    difficulty: Difficulty
    provider: ProviderName
    model: str
    technique: TechniqueName
    success: bool
    failure_cause: FailureCause | None
    raw_response: str
    parsed_payload: dict[str, Any] | None
    latency_ms: int
    predicted_board: list[list[str]] | None
    details: str | None
    usage: dict[str, Any] | None
    job_index: int
    total_jobs: int
    case: BenchmarkCase


class RunSummary(TypedDict):
    provider: ProviderName
    models: list[str]
    dataset_path: str
    techniques: list[TechniqueName]
    totals: dict[str, Any]
    by_technique: dict[str, Any]
    by_difficulty: dict[str, Any]
    failure_breakdown: dict[str, int]
    failure_breakdown_by_technique: dict[str, dict[str, int]]
