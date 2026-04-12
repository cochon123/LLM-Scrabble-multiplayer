from __future__ import annotations

import json

from .types import BenchmarkCase, ContextFormatName, TechniqueName


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
    return build_prompt_for_context_format(case, technique, "summary_delta")


def build_free_play_prompt_for_context_format(case: BenchmarkCase, context_format: ContextFormatName) -> str:
    example = (
        'Example crossing: if the board already contains A at row=1,col=1 and you want to play CAT vertically, '
        'respond with {"tool":"play_move","arguments":{"placements":[{"row":0,"col":1,"letter":"C"},{"row":2,"col":1,"letter":"T"}]}} '
        "and do not repeat the existing A."
    )
    return (
        f"{COMMON_RULES}\n"
        "Task=free_play. You are NOT given a target word. "
        "You must choose any legal move using the rack and return it with play_move. "
        "Legality is more important than score, but prefer a stronger move if you see one.\n"
        'Output format: {"tool":"play_move","arguments":{"placements":[{"row":number,"col":number,"letter":"A"}]}}\n'
        "Return only newly placed letters. If the word crosses a letter already on the board, do not output that square.\n"
        f"{_context_format_line(context_format)}\n"
        f"{example}\n"
        f"rack={''.join(case['rack'])}\n"
        f"{build_context_block(case, context_format)}"
    )


def build_prompt_for_context_format(case: BenchmarkCase, technique: TechniqueName, context_format: ContextFormatName) -> str:
    if technique == "placements_json":
        return build_placements_prompt(case, context_format)
    if technique == "board_matrix_full":
        return build_board_matrix_prompt(case, context_format)
    if technique == "delta_sparse":
        return build_delta_sparse_prompt(case, context_format)
    if technique == "line_slots":
        return build_line_slots_prompt(case, context_format)
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


def build_context_block(case: BenchmarkCase, context_format: ContextFormatName) -> str:
    if context_format == "summary_delta":
        return build_sparse_case_block(case)
    if context_format == "summary_delta_plus_2d_full":
        return (
            f"{build_sparse_case_block(case)}\n"
            "additional_board_2d_full=\n"
            f"{build_board_matrix_case_block(case)}"
        )
    if context_format == "board_2d_full":
        return build_board_matrix_case_block(case)
    if context_format == "board_2d_compact":
        rows = _compact_board_rows(case)
        return (
            "board_2d_rows_compact="
            f"{json.dumps(rows, ensure_ascii=False, separators=(',', ':'))}\n"
            f"{_placement_directive(case)}"
        )
    raise ValueError(f"Format de contexte inconnu: {context_format}")


def _context_format_line(context_format: ContextFormatName) -> str:
    if context_format == "summary_delta":
        return "Context format=summary_delta. The board is provided as compact rows with a legend."
    if context_format == "summary_delta_plus_2d_full":
        return (
            "Context format=summary_delta_plus_2d_full. "
            "The normal compact-row board view is provided, and an additional full 15x15 2D board is appended below."
        )
    if context_format == "board_2d_full":
        return 'Context format=board_2d_full. The board is provided as a full 15x15 2D matrix using only "_","2w","3w","2l","3l" or letters.'
    if context_format == "board_2d_compact":
        return "Context format=board_2d_compact. The board is provided as 15 compact row strings with legend symbols."
    raise ValueError(f"Format de contexte inconnu: {context_format}")


def build_placements_prompt(case: BenchmarkCase, context_format: ContextFormatName) -> str:
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
        f"{_context_format_line(context_format)}\n"
        f"{example}\n"
        f"{build_context_block(case, context_format)}"
    )


def build_board_matrix_prompt(case: BenchmarkCase, context_format: ContextFormatName) -> str:
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
        f"{_context_format_line(context_format)}\n"
        f"{example}\n"
        f"{build_context_block(case, context_format)}"
    )


def build_delta_sparse_prompt(case: BenchmarkCase, context_format: ContextFormatName) -> str:
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
        f"{_context_format_line(context_format)}\n"
        f"{example}\n"
        f"{build_context_block(case, context_format)}"
    )


def build_line_slots_prompt(case: BenchmarkCase, context_format: ContextFormatName) -> str:
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
        f"{_context_format_line(context_format)}\n"
        f"{example}\n"
        f"slots_length={expected_length}\n"
        f"{build_context_block(case, context_format)}"
    )
