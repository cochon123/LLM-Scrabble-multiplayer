from __future__ import annotations

import json

from .types import BenchmarkCase, TechniqueName


COMMON_RULES = (
    "English Scrabble. row/col are 0-indexed. "
    "Place the exact target word. "
    "Return one JSON object only, no markdown. "
    "Do not modify existing letters. "
    "Do not invent letters outside the rack."
)

LEGEND = "Board legend: .=empty @=2w #=3w +=2l *=3l letters=already occupied cells."

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
        "The board already shows which cells are occupied. "
        "If the word crosses an existing letter, keep it and do not re-emit it in a sparse output."
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
        'Example crossing: word=CAT, start_row=0, start_col=1, direction=vertical, '
        'the board already contains A at row=1,col=1. '
        'Response:{"tool":"play_move","arguments":{"placements":'
        '[{"row":0,"col":1,"letter":"C"},{"row":2,"col":1,"letter":"T"}]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=placements_json. Return only newly placed letters. "
        "If the word crosses a letter already on the board, do not output that letter.\n"
        f"{example}\n"
        f"{build_sparse_case_block(case)}"
    )


def build_board_matrix_prompt(case: BenchmarkCase) -> str:
    example = (
        'Example crossing: board=[["_","_","_"],["_","A","_"],["_","_","_"]] '
        'and word=CAT start_row=0 start_col=1 direction=vertical. '
        'Response:{"tool":"play_board","arguments":{"board":'
        ' [["_","C","_"],["_","A","_"],["_","T","_"]]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        'Technique=board_matrix_full. Output a 15x15 matrix using "_","2w","3w","2l","3l" or letters. '
        "If you place on a bonus, replace the bonus token with the letter. "
        "Important: in the output, use ONLY the canonical tokens _,2w,3w,2l,3l and not the compact symbols.\n"
        f"{example}\n"
        f"{build_board_matrix_case_block(case)}"
    )


def build_delta_sparse_prompt(case: BenchmarkCase) -> str:
    example = (
        'Example crossing: word=CAT, start_row=0, start_col=1, direction=vertical, '
        'the board already contains A at row=1,col=1. '
        'Response:{"tool":"play_delta","arguments":{"cells":'
        '[{"row":0,"col":1,"value":"C"},{"row":2,"col":1,"value":"T"}]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=delta_sparse. Return only modified cells. "
        "If the word crosses a letter already on the board, do not output that letter.\n"
        f"{example}\n"
        f"{build_sparse_case_block(case)}"
    )


def build_line_slots_prompt(case: BenchmarkCase) -> str:
    expected_length = len(_line_slots(case))
    example = (
        'Example crossing: word=CAT, start_row=0, start_col=1, direction=vertical, '
        'the board already contains A at row=1,col=1. '
        'Response:{"tool":"play_line","arguments":{"start_row":0,"start_col":1,"direction":"vertical","slots":["C","=","T"]}}'
    )
    return (
        f"{COMMON_RULES}\n"
        "Technique=line_slots. Return an ordered segment with the exact word length. "
        "Each slot item corresponds to one consecutive board cell along the word path. "
        "Use an uppercase letter for a newly placed tile and '=' for a letter already present on the board. "
        "Never return bonus tokens inside slots.\n"
        f"{example}\n"
        f"slots_length={expected_length}\n"
        f"{build_sparse_case_block(case)}"
    )
