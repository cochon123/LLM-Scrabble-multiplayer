from __future__ import annotations

import unittest

from benchmarks.scrabble_toolcall.evaluator import evaluate_raw_response


CASE = {
    "case_id": "case_000001",
    "difficulty": "simple",
    "provider_prompt_language": "en",
    "board_before": [["_" for _ in range(15)] for _ in range(15)],
    "board_after": [["_" for _ in range(15)] for _ in range(15)],
    "rack": ["M", "A"],
    "target_word": "MA",
    "expected_move": {"direction": "horizontal", "cells": [{"row": 7, "col": 7, "letter": "M"}, {"row": 7, "col": 8, "letter": "A"}]},
    "metadata": {},
}
CASE["board_before"][7][7] = "2w"
CASE["board_before"][7][8] = "_"
CASE["board_after"][7][7] = "M"
CASE["board_after"][7][8] = "A"

CROSS_CASE = {
    "case_id": "case_cross",
    "difficulty": "medium",
    "provider_prompt_language": "en",
    "board_before": [["_" for _ in range(15)] for _ in range(15)],
    "board_after": [["_" for _ in range(15)] for _ in range(15)],
    "rack": ["S", "J", "O", "U"],
    "target_word": "SAJOU",
    "expected_move": {
        "direction": "vertical",
        "start_row": 6,
        "start_col": 7,
        "cells": [
            {"row": 6, "col": 7, "letter": "S"},
            {"row": 8, "col": 7, "letter": "J"},
            {"row": 9, "col": 7, "letter": "O"},
            {"row": 10, "col": 7, "letter": "U"},
        ],
    },
    "metadata": {},
}
CROSS_CASE["board_before"][6][7] = "_"
CROSS_CASE["board_before"][7][7] = "A"
CROSS_CASE["board_before"][8][7] = "_"
CROSS_CASE["board_before"][9][7] = "_"
CROSS_CASE["board_before"][10][7] = "_"
CROSS_CASE["board_after"][6][7] = "S"
CROSS_CASE["board_after"][7][7] = "A"
CROSS_CASE["board_after"][8][7] = "J"
CROSS_CASE["board_after"][9][7] = "O"
CROSS_CASE["board_after"][10][7] = "U"


class EvaluatorTests(unittest.TestCase):
    def test_placements_success(self) -> None:
        raw = '{"tool":"play_move","arguments":{"placements":[{"row":7,"col":7,"letter":"M"},{"row":7,"col":8,"letter":"A"}]}}'
        result = evaluate_raw_response(CASE, "placements_json", raw)
        self.assertTrue(result.success)

    def test_delta_out_of_bounds(self) -> None:
        raw = '{"tool":"play_delta","arguments":{"cells":[{"row":99,"col":8,"value":"A"}]}}'
        result = evaluate_raw_response(CASE, "delta_sparse", raw)
        self.assertEqual(result.failure_cause, "out_of_bounds")

    def test_board_wrong_dimensions(self) -> None:
        raw = '{"tool":"play_board","arguments":{"board":[["_"]]}}'
        result = evaluate_raw_response(CASE, "board_matrix_full", raw)
        self.assertEqual(result.failure_cause, "wrong_board_dimensions")

    def test_line_slots_success(self) -> None:
        raw = '{"tool":"play_line","arguments":{"start_row":7,"start_col":7,"direction":"horizontal","slots":["M","A"]}}'
        result = evaluate_raw_response(CASE, "line_slots", raw)
        self.assertTrue(result.success)

    def test_sparse_may_repeat_matching_cross_letter(self) -> None:
        raw = '{"tool":"play_move","arguments":{"placements":[{"row":6,"col":7,"letter":"S"},{"row":7,"col":7,"letter":"A"},{"row":8,"col":7,"letter":"J"},{"row":9,"col":7,"letter":"O"},{"row":10,"col":7,"letter":"U"}]}}'
        result = evaluate_raw_response(CROSS_CASE, "placements_json", raw)
        self.assertTrue(result.success)

    def test_line_slots_may_repeat_matching_cross_letter(self) -> None:
        raw = '{"tool":"play_line","arguments":{"start_row":6,"start_col":7,"direction":"vertical","slots":["S","A","J","O","U"]}}'
        result = evaluate_raw_response(CROSS_CASE, "line_slots", raw)
        self.assertTrue(result.success)


if __name__ == "__main__":
    unittest.main()
