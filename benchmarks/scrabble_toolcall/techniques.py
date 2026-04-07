from __future__ import annotations

from .types import TechniqueName

SUPPORTED_TECHNIQUES: tuple[TechniqueName, ...] = (
    "placements_json",
    "board_matrix_full",
    "delta_sparse",
    "line_slots",
)


def normalize_techniques(values: list[str]) -> list[TechniqueName]:
    normalized: list[TechniqueName] = []
    for value in values:
        if value not in SUPPORTED_TECHNIQUES:
            raise ValueError(f"Technique inconnue: {value}")
        normalized.append(value)  # type: ignore[arg-type]
    return normalized
