from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from typing import Any

from .types import BenchmarkCase, FailureCause, TechniqueName

VALID_BOARD_TOKENS = {"_", "2w", "3w", "2l", "3l"}


@dataclass
class EvaluationOutcome:
    success: bool
    failure_cause: FailureCause | None
    parsed_payload: dict[str, Any] | None
    predicted_board: list[list[str]] | None
    details: str | None = None


def evaluate_raw_response(case: BenchmarkCase, technique: TechniqueName, raw_response: str) -> EvaluationOutcome:
    if not raw_response.strip():
        return EvaluationOutcome(False, "no_response", None, None, "Reponse vide.")

    payload = parse_json_payload(raw_response)
    if payload is None:
        return EvaluationOutcome(False, "not_json", None, None, "Objet JSON introuvable.")
    if not isinstance(payload, dict):
        return EvaluationOutcome(False, "wrong_top_level_shape", None, None, "Le niveau racine doit etre un objet.")

    expected_tool = {
        "placements_json": "play_move",
        "board_matrix_full": "play_board",
        "delta_sparse": "play_delta",
        "line_slots": "play_line",
    }[technique]
    if payload.get("tool") != expected_tool:
        return EvaluationOutcome(False, "wrong_tool_name", payload, None, f"Outil attendu: {expected_tool}.")

    arguments = payload.get("arguments")
    if not isinstance(arguments, dict):
        return EvaluationOutcome(False, "wrong_top_level_shape", payload, None, "Champ arguments manquant ou invalide.")

    if technique == "placements_json":
        return evaluate_placements(case, payload, arguments)
    if technique == "delta_sparse":
        return evaluate_delta(case, payload, arguments)
    if technique == "board_matrix_full":
        return evaluate_board_matrix(case, payload, arguments)
    if technique == "line_slots":
        return evaluate_line_slots(case, payload, arguments)
    raise ValueError(f"Technique inconnue: {technique}")


def parse_json_payload(raw_response: str) -> dict[str, Any] | list[Any] | None:
    content = raw_response.strip()
    for candidate in [content, _extract_braced_json(content)]:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def evaluate_placements(case: BenchmarkCase, payload: dict[str, Any], arguments: dict[str, Any]) -> EvaluationOutcome:
    placements = arguments.get("placements")
    if not isinstance(placements, list):
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "placements doit etre une liste.")

    cells: list[dict[str, Any]] = []
    for item in placements:
        if not isinstance(item, dict):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Chaque placement doit etre un objet.")
        cells.append({"row": item.get("row"), "col": item.get("col"), "letter": item.get("letter")})

    return evaluate_sparse_cells(case, payload, cells, letter_key="letter")


def evaluate_delta(case: BenchmarkCase, payload: dict[str, Any], arguments: dict[str, Any]) -> EvaluationOutcome:
    cells = arguments.get("cells")
    if not isinstance(cells, list):
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "cells doit etre une liste.")

    normalized: list[dict[str, Any]] = []
    for item in cells:
        if not isinstance(item, dict):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Chaque cellule doit etre un objet.")
        normalized.append({"row": item.get("row"), "col": item.get("col"), "letter": item.get("value")})

    return evaluate_sparse_cells(case, payload, normalized, letter_key="letter")


def evaluate_sparse_cells(
    case: BenchmarkCase,
    payload: dict[str, Any],
    cells: list[dict[str, Any]],
    letter_key: str,
) -> EvaluationOutcome:
    seen_coords: set[tuple[int, int]] = set()
    expected = {(cell["row"], cell["col"]): cell["letter"] for cell in case["expected_move"]["cells"]}
    board_before = case["board_before"]
    board_after = [row[:] for row in board_before]
    rack_counter = Counter(case["rack"])
    used_letters: list[str] = []

    for cell in cells:
        row = cell.get("row")
        col = cell.get("col")
        letter = cell.get(letter_key)
        if not isinstance(row, int) or not isinstance(col, int) or not isinstance(letter, str):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Cellule mal formee.")
        if (row, col) in seen_coords:
            return EvaluationOutcome(False, "duplicate_coordinates", payload, None, f"Coordonnee dupliquee: {row},{col}")
        seen_coords.add((row, col))
        if row < 0 or row >= 15 or col < 0 or col >= 15:
            return EvaluationOutcome(False, "out_of_bounds", payload, None, f"Hors plateau: {row},{col}")
        normalized_letter = letter.upper()
        if len(normalized_letter) != 1 or not normalized_letter.isalpha():
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, f"Lettre invalide: {letter!r}")
        if is_letter(board_before[row][col]):
            if board_before[row][col] != normalized_letter:
                return EvaluationOutcome(False, "overwrote_existing_tile", payload, None, f"Case deja occupee: {row},{col}")
            continue
        used_letters.append(normalized_letter)
        board_after[row][col] = normalized_letter

    for letter, count in Counter(used_letters).items():
        if count > rack_counter[letter]:
            return EvaluationOutcome(False, "used_letter_not_in_rack", payload, board_after, f"Lettre {letter} absente ou insuffisante dans le rack.")

    predicted_coords = {(row, col): board_after[row][col] for row in range(15) for col in range(15) if board_before[row][col] != board_after[row][col]}
    missing = [coord for coord in expected if coord not in predicted_coords]
    if missing:
        return EvaluationOutcome(False, "missing_cells", payload, board_after, f"Cases manquantes: {missing[:4]}")
    extras = [coord for coord in predicted_coords if coord not in expected]
    if extras:
        return EvaluationOutcome(False, "extra_cells", payload, board_after, f"Cases en trop: {extras[:4]}")
    wrong_letters = [coord for coord, letter in expected.items() if predicted_coords.get(coord) != letter]
    if wrong_letters:
        return EvaluationOutcome(False, "wrong_letter_at_coordinate", payload, board_after, f"Mauvaises lettres: {wrong_letters[:4]}")
    if board_after != case["board_after"]:
        return EvaluationOutcome(False, "board_after_mismatch", payload, board_after, "Le board final ne correspond pas au board attendu.")
    return EvaluationOutcome(True, None, payload, board_after, None)


def evaluate_line_slots(case: BenchmarkCase, payload: dict[str, Any], arguments: dict[str, Any]) -> EvaluationOutcome:
    start_row = arguments.get("start_row")
    start_col = arguments.get("start_col")
    direction = arguments.get("direction")
    slots = arguments.get("slots")
    expected_move = case["expected_move"]
    expected_start_row = expected_move.get("start_row")
    expected_start_col = expected_move.get("start_col")
    expected_direction = expected_move.get("direction")
    if expected_start_row is None or expected_start_col is None:
        cells = expected_move.get("cells") or []
        if cells:
            expected_start_row = cells[0]["row"]
            expected_start_col = cells[0]["col"]
    if expected_direction is None:
        expected_direction = "horizontal"
    if (
        not isinstance(start_row, int)
        or not isinstance(start_col, int)
        or direction not in {"horizontal", "vertical"}
        or not isinstance(slots, list)
    ):
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "start_row/start_col/direction/slots invalides.")
    if start_row != expected_start_row or start_col != expected_start_col or direction != expected_direction:
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Reference de segment incorrecte.")
    if len(slots) != len(case["target_word"]):
        return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "Longueur de slots invalide.")

    board_before = case["board_before"]
    board_after = [row[:] for row in board_before]
    rack_counter = Counter(case["rack"])
    used_letters: list[str] = []
    vertical = direction == "vertical"

    for index, token in enumerate(slots):
        if not isinstance(token, str):
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, "slot non string.")
        row = start_row + index if vertical else start_row
        col = start_col if vertical else start_col + index
        if row < 0 or row >= 15 or col < 0 or col >= 15:
            return EvaluationOutcome(False, "out_of_bounds", payload, None, f"Hors plateau: {row},{col}")
        expected_letter = case["target_word"][index]
        before = board_before[row][col]
        if token == "=":
            if before != expected_letter:
                return EvaluationOutcome(False, "missing_cells", payload, board_after, f"Croisement attendu absent en {row},{col}")
            continue
        normalized = token.upper()
        if len(normalized) != 1 or not normalized.isalpha():
            return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, None, f"slot invalide: {token!r}")
        if normalized != expected_letter:
            return EvaluationOutcome(False, "wrong_letter_at_coordinate", payload, board_after, f"Mauvaise lettre en {row},{col}")
        if is_letter(before):
            if before != normalized:
                return EvaluationOutcome(False, "overwrote_existing_tile", payload, board_after, f"Case deja occupee: {row},{col}")
            continue
        used_letters.append(normalized)
        board_after[row][col] = normalized

    for letter, count in Counter(used_letters).items():
        if count > rack_counter[letter]:
            return EvaluationOutcome(False, "used_letter_not_in_rack", payload, board_after, f"Lettre {letter} absente ou insuffisante dans le rack.")

    expected_changes = {(cell["row"], cell["col"]): cell["letter"] for cell in case["expected_move"]["cells"]}
    predicted_changes = {
        (row, col): board_after[row][col]
        for row in range(15)
        for col in range(15)
        if board_before[row][col] != board_after[row][col]
    }
    missing = [coord for coord in expected_changes if coord not in predicted_changes]
    if missing:
        return EvaluationOutcome(False, "missing_cells", payload, board_after, f"Cases manquantes: {missing[:4]}")
    extras = [coord for coord in predicted_changes if coord not in expected_changes]
    if extras:
        return EvaluationOutcome(False, "extra_cells", payload, board_after, f"Cases en trop: {extras[:4]}")
    if board_after != case["board_after"]:
        return EvaluationOutcome(False, "board_after_mismatch", payload, board_after, "Le board final ne correspond pas au board attendu.")
    return EvaluationOutcome(True, None, payload, board_after, None)


def evaluate_board_matrix(case: BenchmarkCase, payload: dict[str, Any], arguments: dict[str, Any]) -> EvaluationOutcome:
    board = arguments.get("board")
    if not isinstance(board, list):
        return EvaluationOutcome(False, "wrong_board_dimensions", payload, None, "board doit etre une matrice 15x15.")
    if len(board) != 15 or any(not isinstance(row, list) or len(row) != 15 for row in board):
        return EvaluationOutcome(False, "wrong_board_dimensions", payload, None, "Dimensions invalides.")

    predicted_board: list[list[str]] = []
    for row in board:
        predicted_row: list[str] = []
        for token in row:
            if not isinstance(token, str):
                return EvaluationOutcome(False, "invalid_board_token", payload, None, "Token non string.")
            normalized = token.upper() if len(token) == 1 else token.lower()
            if not is_letter_token(normalized) and normalized not in VALID_BOARD_TOKENS:
                return EvaluationOutcome(False, "invalid_board_token", payload, None, f"Token invalide: {token}")
            predicted_row.append(normalized if normalized in VALID_BOARD_TOKENS else normalized.upper())
        predicted_board.append(predicted_row)

    board_before = case["board_before"]
    expected_changes = {(cell["row"], cell["col"]): cell["letter"] for cell in case["expected_move"]["cells"]}
    rack_counter = Counter(case["rack"])
    used_letters: list[str] = []

    for row in range(15):
        for col in range(15):
            before = board_before[row][col]
            after = predicted_board[row][col]
            if is_letter(before):
                if after != before:
                    return EvaluationOutcome(False, "modified_unrelated_existing_tile", payload, predicted_board, f"Modification interdite en {row},{col}")
                continue
            if is_letter(after):
                used_letters.append(after)
            elif after != before:
                return EvaluationOutcome(False, "technique_specific_invalid_payload", payload, predicted_board, f"Token bonus modifie sans lettre en {row},{col}")

    for letter, count in Counter(used_letters).items():
        if count > rack_counter[letter]:
            return EvaluationOutcome(False, "used_letter_not_in_rack", payload, predicted_board, f"Lettre {letter} absente ou insuffisante dans le rack.")

    predicted_changes = {
        (row, col): predicted_board[row][col]
        for row in range(15)
        for col in range(15)
        if board_before[row][col] != predicted_board[row][col]
    }
    missing = [coord for coord in expected_changes if coord not in predicted_changes]
    if missing:
        return EvaluationOutcome(False, "missing_cells", payload, predicted_board, f"Cases manquantes: {missing[:4]}")
    extras = [coord for coord in predicted_changes if coord not in expected_changes]
    if extras:
        return EvaluationOutcome(False, "extra_cells", payload, predicted_board, f"Cases en trop: {extras[:4]}")
    wrong_letters = [coord for coord, letter in expected_changes.items() if predicted_changes.get(coord) != letter]
    if wrong_letters:
        return EvaluationOutcome(False, "wrong_letter_at_coordinate", payload, predicted_board, f"Mauvaises lettres: {wrong_letters[:4]}")
    if predicted_board != case["board_after"]:
        return EvaluationOutcome(False, "board_after_mismatch", payload, predicted_board, "Le board final ne correspond pas au board attendu.")
    return EvaluationOutcome(True, None, payload, predicted_board, None)


def is_letter(value: str) -> bool:
    return is_letter_token(value)


def is_letter_token(value: str) -> bool:
    return len(value) == 1 and value.isalpha() and value.upper() == value


def _extract_braced_json(raw: str) -> str | None:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return raw[start : end + 1]
