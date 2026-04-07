from __future__ import annotations

import json

from .types import BenchmarkCase, TechniqueName


COMMON_RULES = (
    "Scrabble fr. row/col 0-indexed. "
    "Place exactement le mot donne. "
    "Un seul JSON, sans markdown. "
    "Ne modifie pas les lettres existantes. "
    "N'invente pas de lettres hors rack."
)

LEGEND = "Legende board: .=vide @=2w #=3w +=2l *=3l lettres=cases deja occupees."

BONUS_TO_CHAR = {
    "_": ".",
    "2w": "@",
    "3w": "#",
    "2l": "+",
    "3l": "*",
}


def _compact_board_rows(case: BenchmarkCase) -> list[str]:
    rows: list[str] = []
    for row in case["board_before"]:
        chars: list[str] = []
        for cell in row:
            chars.append(BONUS_TO_CHAR.get(cell, cell))
        rows.append("".join(chars))
    return rows


def _canonical_board(case: BenchmarkCase) -> list[list[str]]:
    return [row[:] for row in case["board_before"]]


def _word_path(case: BenchmarkCase) -> list[tuple[int, int, str]]:
    row = case["expected_move"]["start_row"]
    col = case["expected_move"]["start_col"]
    vertical = case["expected_move"]["direction"] == "vertical"
    coords: list[tuple[int, int, str]] = []
    for index, letter in enumerate(case["target_word"]):
        current_row = row + index if vertical else row
        current_col = col if vertical else col + index
        coords.append((current_row, current_col, letter))
    return coords


def _placement_directive(case: BenchmarkCase) -> str:
    direction = "vertical" if case["expected_move"]["direction"] == "vertical" else "horizontal"
    return (
        f"word={case['target_word']}\n"
        f"rack={''.join(case['rack'])}\n"
        f"start_row={case['expected_move']['start_row']}\n"
        f"start_col={case['expected_move']['start_col']}\n"
        f"direction={direction}\n"
        "Le board indique deja quelles cases sont occupees. "
        "Si le mot croise une lettre deja presente, conserve-la et ne la re-emets pas dans une sortie sparse."
    )


def _line_slots(case: BenchmarkCase) -> list[str]:
    slots: list[str] = []
    for row, col, letter in _word_path(case):
        slots.append("=" if case["board_before"][row][col] == letter else letter)
    return slots


def build_prompt(case: BenchmarkCase, technique: TechniqueName) -> str:
    if technique == "placements_json":
        return build_placements_prompt(case)
    if technique == "board_matrix_full":
        return build_board_matrix_prompt(case)
    if technique == "delta_sparse":
        return build_delta_sparse_prompt(case)
    if technique == "line_slots":
        return build_line_slots_prompt(case)
    raise ValueError(f"Technique inconnue: {technique}")


def build_sparse_case_block(case: BenchmarkCase) -> str:
    direction = "h" if case["expected_move"]["direction"] == "horizontal" else "v"
    rows = _compact_board_rows(case)
    return (
        f"{LEGEND}\n"
        f"rows={json.dumps(rows, ensure_ascii=False, separators=(',', ':'))}\n"
        f"place={direction},{case['expected_move']['start_row']},{case['expected_move']['start_col']}\n"
        f"{_placement_directive(case)}"
    )


def build_board_matrix_case_block(case: BenchmarkCase) -> str:
    board = _canonical_board(case)
    return (
        f"board={json.dumps(board, ensure_ascii=False, separators=(',', ':'))}\n"
        f"{_placement_directive(case)}"
    )


def build_placements_prompt(case: BenchmarkCase) -> str:
    example = (
        'Exemple croisement: mot=CAT, start_row=0, start_col=1, direction=vertical, '
        'le board contient deja A en row=1,col=1. '
        'Reponse:{"tool":"play_move","arguments":{"placements":'
        '[{"row":0,"col":1,"letter":"C"},{"row":2,"col":1,"letter":"T"}]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=placements_json. Retourne seulement les nouvelles lettres. "
        "Si le mot croise une lettre deja sur le plateau, ne renvoie pas cette lettre.\n"
        f"{example}\n"
        f"{build_sparse_case_block(case)}"
    )


def build_board_matrix_prompt(case: BenchmarkCase) -> str:
    example = (
        'Exemple croisement: board=[["_","_","_"],["_","A","_"],["_","_","_"]] '
        'et mot=CAT start_row=0 start_col=1 direction=vertical. '
        'Reponse:{"tool":"play_board","arguments":{"board":'
        ' [["_","C","_"],["_","A","_"],["_","T","_"]]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        'Technique=board_matrix_full. Sortie=matrice 15x15 avec "_","2w","3w","2l","3l" ou lettres. '
        "Si tu poses sur un bonus, remplace le bonus par la lettre. "
        "Important: en sortie, utilise UNIQUEMENT les tokens canoniques _,2w,3w,2l,3l et pas les symboles compactes.\n"
        f"{example}\n"
        f"{build_board_matrix_case_block(case)}"
    )


def build_delta_sparse_prompt(case: BenchmarkCase) -> str:
    example = (
        'Exemple croisement: mot=CAT, start_row=0, start_col=1, direction=vertical, '
        'le board contient deja A en row=1,col=1. '
        'Reponse:{"tool":"play_delta","arguments":{"cells":'
        '[{"row":0,"col":1,"value":"C"},{"row":2,"col":1,"value":"T"}]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=delta_sparse. Retourne seulement les cellules modifiees. "
        "Si le mot croise une lettre deja sur le plateau, ne renvoie pas cette lettre.\n"
        f"{example}\n"
        f"{build_sparse_case_block(case)}"
    )


def build_line_slots_prompt(case: BenchmarkCase) -> str:
    expected_length = len(_line_slots(case))
    example = (
        'Exemple croisement: mot=CAT, start_row=0, start_col=1, direction=vertical, '
        'le board contient deja A en row=1,col=1. '
        'Reponse:{"tool":"play_line","arguments":{"start_row":0,"start_col":1,"direction":"vertical","slots":["C","=","T"]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=line_slots. Retourne un segment ordonne de longueur exacte du mot. "
        "Chaque element de slots correspond a une case consecutive du mot. "
        "Utilise une lettre majuscule pour une nouvelle tuile et '=' pour une lettre deja presente sur le plateau. "
        "Ne renvoie jamais les bonus dans slots.\n"
        f"{example}\n"
        f"slots_length={expected_length}\n"
        f"{build_sparse_case_block(case)}"
    )
