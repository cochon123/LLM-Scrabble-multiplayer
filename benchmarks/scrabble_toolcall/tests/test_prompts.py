from __future__ import annotations

import unittest

from benchmarks.scrabble_toolcall.prompts import build_prompt_for_context_format


CASE = {
    "case_id": "case_000001",
    "difficulty": "simple",
    "provider_prompt_language": "en",
    "board_before": [["_" for _ in range(15)] for _ in range(15)],
    "board_after": [["_" for _ in range(15)] for _ in range(15)],
    "rack": ["M", "A"],
    "target_word": "MA",
    "expected_move": {
        "direction": "horizontal",
        "start_row": 7,
        "start_col": 7,
        "cells": [{"row": 7, "col": 7, "letter": "M"}, {"row": 7, "col": 8, "letter": "A"}],
    },
    "metadata": {},
}
CASE["board_before"][7][7] = "2w"
CASE["board_before"][7][8] = "_"
CASE["board_after"][7][7] = "M"
CASE["board_after"][7][8] = "A"


class PromptTests(unittest.TestCase):
    def test_summary_delta_prompt_uses_compact_rows(self) -> None:
        prompt = build_prompt_for_context_format(CASE, "placements_json", "summary_delta")
        self.assertIn("rows=", prompt)
        self.assertNotIn("board=[[", prompt)

    def test_board_2d_full_prompt_uses_matrix(self) -> None:
        prompt = build_prompt_for_context_format(CASE, "placements_json", "board_2d_full")
        self.assertIn("board=[[", prompt)
        self.assertNotIn("rows=", prompt)

    def test_summary_delta_plus_2d_full_contains_both_views(self) -> None:
        prompt = build_prompt_for_context_format(CASE, "placements_json", "summary_delta_plus_2d_full")
        self.assertIn("rows=", prompt)
        self.assertIn("additional_board_2d_full=", prompt)
        self.assertIn("board=[[", prompt)

    def test_board_2d_compact_prompt_uses_compact_board_rows(self) -> None:
        prompt = build_prompt_for_context_format(CASE, "placements_json", "board_2d_compact")
        self.assertIn("board_2d_rows_compact=", prompt)
        self.assertNotIn("board=[[", prompt)


if __name__ == "__main__":
    unittest.main()
