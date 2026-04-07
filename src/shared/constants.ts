import type { BonusType } from "./types.js";

export const BOARD_SIZE = 15;
export const RACK_SIZE = 7;
export const MAX_PLAYERS = 4;
export const CENTER = { row: 7, col: 7 } as const;

export const LETTER_DISTRIBUTION: Record<
  string,
  {
    count: number;
    value: number;
  }
> = {
  A: { count: 9, value: 1 },
  B: { count: 2, value: 3 },
  C: { count: 2, value: 3 },
  D: { count: 3, value: 2 },
  E: { count: 15, value: 1 },
  F: { count: 2, value: 4 },
  G: { count: 2, value: 2 },
  H: { count: 2, value: 4 },
  I: { count: 8, value: 1 },
  J: { count: 1, value: 8 },
  K: { count: 1, value: 10 },
  L: { count: 5, value: 1 },
  M: { count: 3, value: 2 },
  N: { count: 6, value: 1 },
  O: { count: 6, value: 1 },
  P: { count: 2, value: 3 },
  Q: { count: 1, value: 8 },
  R: { count: 6, value: 1 },
  S: { count: 6, value: 1 },
  T: { count: 6, value: 1 },
  U: { count: 6, value: 1 },
  V: { count: 2, value: 4 },
  W: { count: 1, value: 10 },
  X: { count: 1, value: 10 },
  Y: { count: 1, value: 10 },
  Z: { count: 1, value: 10 },
  "?": { count: 2, value: 0 }
};

const specials: Array<[number, number, BonusType]> = [
  [0, 0, "tw"],
  [0, 7, "tw"],
  [0, 14, "tw"],
  [7, 0, "tw"],
  [7, 14, "tw"],
  [14, 0, "tw"],
  [14, 7, "tw"],
  [14, 14, "tw"],
  [1, 1, "dw"],
  [2, 2, "dw"],
  [3, 3, "dw"],
  [4, 4, "dw"],
  [10, 10, "dw"],
  [11, 11, "dw"],
  [12, 12, "dw"],
  [13, 13, "dw"],
  [1, 13, "dw"],
  [2, 12, "dw"],
  [3, 11, "dw"],
  [4, 10, "dw"],
  [10, 4, "dw"],
  [11, 3, "dw"],
  [12, 2, "dw"],
  [13, 1, "dw"],
  [1, 5, "tl"],
  [1, 9, "tl"],
  [5, 1, "tl"],
  [5, 5, "tl"],
  [5, 9, "tl"],
  [5, 13, "tl"],
  [9, 1, "tl"],
  [9, 5, "tl"],
  [9, 9, "tl"],
  [9, 13, "tl"],
  [13, 5, "tl"],
  [13, 9, "tl"],
  [0, 3, "dl"],
  [0, 11, "dl"],
  [2, 6, "dl"],
  [2, 8, "dl"],
  [3, 0, "dl"],
  [3, 7, "dl"],
  [3, 14, "dl"],
  [6, 2, "dl"],
  [6, 6, "dl"],
  [6, 8, "dl"],
  [6, 12, "dl"],
  [7, 3, "dl"],
  [7, 11, "dl"],
  [8, 2, "dl"],
  [8, 6, "dl"],
  [8, 8, "dl"],
  [8, 12, "dl"],
  [11, 0, "dl"],
  [11, 7, "dl"],
  [11, 14, "dl"],
  [12, 6, "dl"],
  [12, 8, "dl"],
  [14, 3, "dl"],
  [14, 11, "dl"]
];

export function getBonus(row: number, col: number): BonusType {
  if (row === CENTER.row && col === CENTER.col) {
    return "center";
  }

  for (const [specialRow, specialCol, bonus] of specials) {
    if (row === specialRow && col === specialCol) {
      return bonus;
    }
  }

  return "normal";
}
