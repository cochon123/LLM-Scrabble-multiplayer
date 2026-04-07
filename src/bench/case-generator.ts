import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Dictionary } from "../shared/dictionary.js";
import { ScrabbleGame } from "../shared/game.js";
import { BOARD_SIZE, CENTER, LETTER_DISTRIBUTION } from "../shared/constants.js";
import type { BoardCell, Direction, PlacementInput, PlayerSeat, Tile } from "../shared/types.js";

export type BenchmarkDifficulty = "simple" | "medium" | "hard";

export interface BenchmarkExpectedCell {
  row: number;
  col: number;
  letter: string;
}

export interface BenchmarkCase {
  case_id: string;
  difficulty: BenchmarkDifficulty;
  provider_prompt_language: "fr";
  board_before: string[][];
  board_after: string[][];
  rack: string[];
  target_word: string;
  expected_move: {
    direction: Direction;
    start_row: number;
    start_col: number;
    cells: BenchmarkExpectedCell[];
  };
  metadata: {
    board_occupancy: number;
    bonus_cells_used: string[];
    cross_words_count: number;
    seed_word_count: number;
    local_constraint_score: number;
  };
}

export interface GenerateDatasetOptions {
  count: number;
  simple: number;
  medium: number;
  hard: number;
  out: string;
  seed: number;
  dictionaryPath: string;
}

interface DifficultyConfig {
  seedMovesMin: number;
  seedMovesMax: number;
  targetWordMin: number;
  targetWordMax: number;
  minOccupancy: number;
  maxOccupancy: number;
  minCrossWords: number;
  minConstraintScore: number;
  requireBonus: boolean;
  candidateBudget: number;
}

interface CandidateMove {
  word: string;
  placements: PlacementInput[];
  direction: Direction;
  startRow: number;
  startCol: number;
  score: number;
  crossWordsCount: number;
  bonusCellsUsed: string[];
  localConstraintScore: number;
  placementLetters: Record<string, string>;
}

const DIFFICULTY_CONFIG: Record<BenchmarkDifficulty, DifficultyConfig> = {
  simple: {
    seedMovesMin: 2,
    seedMovesMax: 3,
    targetWordMin: 3,
    targetWordMax: 5,
    minOccupancy: 0,
    maxOccupancy: 0.16,
    minCrossWords: 0,
    minConstraintScore: 0,
    requireBonus: false,
    candidateBudget: 90
  },
  medium: {
    seedMovesMin: 3,
    seedMovesMax: 5,
    targetWordMin: 4,
    targetWordMax: 6,
    minOccupancy: 0.01,
    maxOccupancy: 0.24,
    minCrossWords: 0,
    minConstraintScore: 0,
    requireBonus: false,
    candidateBudget: 140
  },
  hard: {
    seedMovesMin: 5,
    seedMovesMax: 7,
    targetWordMin: 5,
    targetWordMax: 7,
    minOccupancy: 0.02,
    maxOccupancy: 0.4,
    minCrossWords: 0,
    minConstraintScore: 0,
    requireBonus: false,
    candidateBudget: 220
  }
};

const LETTER_COMMONNESS: Record<string, number> = {
  E: 13,
  A: 12,
  I: 11,
  S: 11,
  N: 10,
  R: 10,
  T: 9,
  O: 9,
  L: 8,
  U: 8,
  D: 7,
  C: 7,
  M: 7,
  P: 6,
  V: 5,
  G: 5,
  F: 4,
  B: 4,
  H: 3,
  Q: 3,
  J: 2,
  X: 2,
  Y: 2,
  Z: 2,
  K: 1,
  W: 1
};

const DEFAULT_DICTIONARY_PATH = "public/dictionary/fr-large.txt";

export async function generateDataset(options: GenerateDatasetOptions): Promise<BenchmarkCase[]> {
  validateSplit(options);
  const dictionaryContent = await readFile(options.dictionaryPath, "utf8");
  const dictionary = new Dictionary(dictionaryContent);
  const random = createRandom(options.seed);
  const pools = createWordPools(dictionary, random);
  const cases: BenchmarkCase[] = [];

  for (const difficulty of ["simple", "medium", "hard"] as const) {
    const targetCount = options[difficulty];
    let attempts = 0;
    while (cases.filter((item) => item.difficulty === difficulty).length < targetCount) {
      attempts += 1;
      if (attempts > Math.max(200, targetCount * 500)) {
        throw new Error(`Generation bloquee pour la difficulte ${difficulty}. Essayez un autre seed ou un split plus petit.`);
      }
      const index = cases.length + 1;
      const generated = generateSingleCase(dictionary, pools, difficulty, index, random);
      if (generated) {
        cases.push(generated);
      }
    }
  }

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(
    options.out,
    `${cases
      .map((item) => JSON.stringify(item))
      .join("\n")}\n`,
    "utf8"
  );
  return cases;
}

export async function inspectCase(datasetPath: string, caseId: string): Promise<BenchmarkCase | null> {
  const content = await readFile(datasetPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as BenchmarkCase;
    if (parsed.case_id === caseId) {
      return parsed;
    }
  }
  return null;
}

export function getDefaultDictionaryPath(): string {
  return DEFAULT_DICTIONARY_PATH;
}

function validateSplit(options: GenerateDatasetOptions): void {
  const expected = options.simple + options.medium + options.hard;
  if (expected !== options.count) {
    throw new Error(`Le total simple+medium+hard (${expected}) doit être égal à count (${options.count}).`);
  }
}

function generateSingleCase(
  dictionary: Dictionary,
  pools: ReturnType<typeof createWordPools>,
  difficulty: BenchmarkDifficulty,
  index: number,
  random: () => number
): BenchmarkCase | null {
  if (difficulty === "simple") {
    return buildSimpleCase(dictionary, pools, difficulty, index, random);
  }
  if (difficulty === "medium") {
    return buildAnchoredCase(dictionary, pools, difficulty, index, random, {
      anchorDirection: "horizontal",
      crossDirection: "vertical",
      crossRow: CENTER.row,
      crossCol: CENTER.col,
      seedWordCount: 1
    });
  }
  return buildAnchoredCase(dictionary, pools, difficulty, index, random, {
    anchorDirection: "vertical",
    crossDirection: "horizontal",
    crossRow: CENTER.row,
    crossCol: CENTER.col,
    seedWordCount: 1
  });
}

function buildSimpleCase(
  dictionary: Dictionary,
  pools: ReturnType<typeof createWordPools>,
  difficulty: BenchmarkDifficulty,
  index: number,
  random: () => number
): BenchmarkCase | null {
  const config = DIFFICULTY_CONFIG[difficulty];
  const targets = pickWordSlice(
    pools.targetWords.filter((word) => word.length >= config.targetWordMin && word.length <= config.targetWordMax),
    320,
    random
  );
  for (const word of targets) {
    const game = createControlledGame(dictionary);
    const direction: Direction = word.length % 2 === 0 ? "vertical" : "horizontal";
    const startRow = direction === "horizontal" ? CENTER.row : CENTER.row - Math.floor(word.length / 2);
    const startCol = direction === "horizontal" ? CENTER.col - Math.floor(word.length / 2) : CENTER.col;
    const move = evaluateWordAt(game, "p1", word, startRow, startCol, direction);
    if (!move) {
      continue;
    }
    return createBenchmarkCase(index, difficulty, game, word, move, 0);
  }
  return null;
}

function buildAnchoredCase(
  dictionary: Dictionary,
  pools: ReturnType<typeof createWordPools>,
  difficulty: BenchmarkDifficulty,
  index: number,
  random: () => number,
  layout: {
    anchorDirection: Direction;
    crossDirection: Direction;
    crossRow: number;
    crossCol: number;
    seedWordCount: number;
  }
): BenchmarkCase | null {
  const config = DIFFICULTY_CONFIG[difficulty];
  const targets = pickWordSlice(
    pools.targetWords.filter((word) => word.length >= config.targetWordMin && word.length <= config.targetWordMax),
    360,
    random
  );
  const anchors = pickWordSlice(pools.seedWords.filter((word) => word.length >= 3 && word.length <= 7), 420, random);

  for (const targetWord of targets) {
    for (const anchorWord of anchors) {
      if (targetWord === anchorWord) {
        continue;
      }
      for (const sharedLetter of findUniqueSharedLetters(targetWord, anchorWord)) {
        const targetIndex = targetWord.indexOf(sharedLetter);
        const anchorIndex = anchorWord.indexOf(sharedLetter);
        const anchorStartRow = layout.anchorDirection === "horizontal" ? layout.crossRow : layout.crossRow - anchorIndex;
        const anchorStartCol = layout.anchorDirection === "horizontal" ? layout.crossCol - anchorIndex : layout.crossCol;
        const targetStartRow = layout.crossDirection === "horizontal" ? layout.crossRow : layout.crossRow - targetIndex;
        const targetStartCol = layout.crossDirection === "horizontal" ? layout.crossCol - targetIndex : layout.crossCol;
        if (!fitsOnBoard(anchorStartRow, anchorStartCol, anchorWord.length, layout.anchorDirection)) {
          continue;
        }
        if (!fitsOnBoard(targetStartRow, targetStartCol, targetWord.length, layout.crossDirection)) {
          continue;
        }

        const game = createControlledGame(dictionary);
        stampWordOnBoard(game.board, anchorWord, anchorStartRow, anchorStartCol, layout.anchorDirection);
        const move = evaluateWordAt(game, "p1", targetWord, targetStartRow, targetStartCol, layout.crossDirection);
        if (!move) {
          continue;
        }
        if (move.crossWordsCount < config.minCrossWords) {
          continue;
        }
        if (move.localConstraintScore < config.minConstraintScore) {
          continue;
        }
        if (config.requireBonus && move.bonusCellsUsed.length === 0) {
          continue;
        }
        return createBenchmarkCase(index, difficulty, game, targetWord, move, layout.seedWordCount);
      }
    }
  }
  return null;
}

function createBenchmarkCase(
  index: number,
  difficulty: BenchmarkDifficulty,
  game: ScrabbleGame,
  targetWord: string,
  move: CandidateMove,
  seedWordCount: number
): BenchmarkCase {
  const boardBefore = boardToBenchmarkMatrix(game.board);
  const boardAfter = applyPlacementsToMatrix(boardBefore, move.placements, move.placementLetters);
  const occupancy = getBoardOccupancy(game.board);
  return {
    case_id: `case_${String(index).padStart(6, "0")}`,
    difficulty,
    provider_prompt_language: "fr",
    board_before: boardBefore,
    board_after: boardAfter,
    rack: targetWord.split(""),
    target_word: targetWord,
    expected_move: {
      direction: move.direction,
      start_row: move.startRow,
      start_col: move.startCol,
      cells: move.placements.map((placement) => ({
        row: placement.row,
        col: placement.col,
        letter: move.placementLetters[coordKey(placement.row, placement.col)] ?? ""
      }))
    },
    metadata: {
      board_occupancy: Number(occupancy.toFixed(4)),
      bonus_cells_used: [...new Set(move.bonusCellsUsed)],
      cross_words_count: move.crossWordsCount,
      seed_word_count: seedWordCount,
      local_constraint_score: move.localConstraintScore
    }
  };
}

function createWordPools(dictionary: Dictionary, random: () => number) {
  const words = dictionary
    .getWords()
    .filter((word) => /^[A-Z]+$/.test(word) && word.length >= 2 && word.length <= 7 && !word.includes("?"));

  const ranked = [...words].sort((left, right) => scoreWord(right) - scoreWord(left) || left.localeCompare(right));
  const seedWords = shuffle([...ranked.filter((word) => word.length >= 2 && word.length <= 6)], random);
  const targetWords = shuffle([...ranked.filter((word) => word.length >= 3 && word.length <= 7)], random);

  return {
    seedWords,
    targetWords
  };
}

function tryBuildTargetCase(
  game: ScrabbleGame,
  pool: string[],
  difficulty: BenchmarkDifficulty,
  seedWordCount: number,
  index: number,
  random: () => number
): BenchmarkCase | null {
  const config = DIFFICULTY_CONFIG[difficulty];
  const occupancy = getBoardOccupancy(game.board);
  if (occupancy < config.minOccupancy || occupancy > config.maxOccupancy) {
    return null;
  }

  const words = pickWordSlice(
    pool.filter((word) => word.length >= config.targetWordMin && word.length <= config.targetWordMax),
    config.candidateBudget,
    random
  );
  const anchors = shuffle(getOccupiedCells(game.board), random);

  for (const word of words) {
    for (const anchor of anchors) {
      const candidateDirections: Direction[] = anchor.row === CENTER.row ? ["vertical", "horizontal"] : ["horizontal", "vertical"];
      for (const direction of candidateDirections) {
        for (const occurrence of findOccurrences(word, anchor.letter)) {
          const startRow = direction === "horizontal" ? anchor.row : anchor.row - occurrence;
          const startCol = direction === "horizontal" ? anchor.col - occurrence : anchor.col;
          const move = evaluateWordAt(game, "p1", word, startRow, startCol, direction);
          if (!move) {
            continue;
          }

          const uniqueMoves = findValidMovesForWord(game, "p1", word);
          if (uniqueMoves.length !== 1 || serializeCandidate(uniqueMoves[0]) !== serializeCandidate(move)) {
            continue;
          }
          if (move.crossWordsCount < config.minCrossWords) {
            continue;
          }
          if (move.localConstraintScore < config.minConstraintScore) {
            continue;
          }
          if (config.requireBonus && move.bonusCellsUsed.length === 0) {
            continue;
          }

          const boardBefore = boardToBenchmarkMatrix(game.board);
          const boardAfter = applyPlacementsToMatrix(boardBefore, move.placements, move.placementLetters);

          return {
            case_id: `case_${String(index).padStart(6, "0")}`,
            difficulty,
            provider_prompt_language: "fr",
            board_before: boardBefore,
            board_after: boardAfter,
            rack: word.split(""),
            target_word: word,
            expected_move: {
              direction: move.direction,
              start_row: move.startRow,
              start_col: move.startCol,
              cells: move.placements.map((placement) => ({
                row: placement.row,
                col: placement.col,
                letter: move.placementLetters[coordKey(placement.row, placement.col)] ?? ""
              }))
            },
            metadata: {
              board_occupancy: Number(occupancy.toFixed(4)),
              bonus_cells_used: [...new Set(move.bonusCellsUsed)],
              cross_words_count: move.crossWordsCount,
              seed_word_count: seedWordCount,
              local_constraint_score: move.localConstraintScore
            }
          };
        }
      }
    }
  }

  return null;
}

function findValidMovesForWord(game: ScrabbleGame, playerId: string, word: string): CandidateMove[] {
  const player = game.getPlayer(playerId);
  if (!player) {
    return [];
  }

  player.rack = createRackFromWord(word);
  const internalGame = game as unknown as InternalScrabbleGame;
  const matchWordToBoard = internalGame.matchWordToBoard.bind(game) as internalMatchWord;
  const evaluateMove = internalGame.evaluateMove.bind(game) as internalEvaluateMove;
  const moves = new Map<string, CandidateMove>();

  for (const direction of ["horizontal", "vertical"] as const) {
    const maxRow = direction === "horizontal" ? BOARD_SIZE : BOARD_SIZE - word.length + 1;
    const maxCol = direction === "horizontal" ? BOARD_SIZE - word.length + 1 : BOARD_SIZE;

    for (let row = 0; row < maxRow; row += 1) {
      for (let col = 0; col < maxCol; col += 1) {
        const move = evaluateWordAt(game, playerId, word, row, col, direction, player, matchWordToBoard, evaluateMove);
        if (!move) {
          continue;
        }
        const key = serializeCandidate(move);
        if (!moves.has(key)) {
          moves.set(key, move);
        }
      }
    }
  }

  return [...moves.values()];
}

type internalMatchWord = (player: { rack: Tile[] }, word: string, row: number, col: number, direction: Direction) => PlacementInput[];
type internalEvaluateMove =
  | ((playerId: string, placements: PlacementInput[]) => { ok: false; error: string })
  | ((playerId: string, placements: PlacementInput[]) => {
      ok: true;
      value: {
        totalScore: number;
        formedWords: Array<{ word: string }>;
      };
    });

interface InternalScrabbleGame {
  matchWordToBoard: internalMatchWord;
  evaluateMove: internalEvaluateMove;
}

function buildSeedBoard(game: ScrabbleGame, pool: string[], difficulty: BenchmarkDifficulty, random: () => number): number | null {
  const anchorLengths = difficulty === "simple" ? [4, 5] : difficulty === "medium" ? [4, 5, 6] : [5, 6, 7];
  const anchorWord = pickWordByLengths(pool, anchorLengths, random);
  if (!anchorWord) {
    return null;
  }
  const anchorCol = Math.max(0, Math.min(BOARD_SIZE - anchorWord.length, 7 - Math.floor(anchorWord.length / 2)));
  const opening = tryPlaceWordAt(game, "p1", anchorWord, 7, anchorCol, "horizontal");
  if (!opening) {
    return null;
  }

  let count = 1;
  if (difficulty === "simple") {
    return count;
  }

  const firstCross = tryPlaceCrossingWord(game, "p2", pool, opening, random);
  if (!firstCross) {
    return null;
  }
  count += 1;

  if (difficulty === "medium") {
    return count;
  }

  const secondCross = tryPlaceCrossingWord(game, "p1", pool, firstCross, random);
  if (!secondCross) {
    return null;
  }
  count += 1;

  const thirdCross = tryPlaceCrossingWord(game, "p2", pool, opening, random);
  if (thirdCross) {
    count += 1;
  }
  return count;
}

function tryPlaceCrossingWord(
  game: ScrabbleGame,
  playerId: string,
  pool: string[],
  baseMove: CandidateMove,
  random: () => number
): CandidateMove | null {
  const baseCells = getWordCells(baseMove.word, baseMove.startRow, baseMove.startCol, baseMove.direction);
  const anchors = shuffle(baseCells.slice(1, Math.max(2, baseCells.length - 1)), random);
  for (const anchor of anchors) {
    const candidateWords = pickWordSlice(
      pool.filter((word) => word !== baseMove.word && word.length >= 3 && word.length <= 7 && word.includes(anchor.letter)),
      80,
      random
    );
    for (const word of candidateWords) {
      for (const occurrence of findOccurrences(word, anchor.letter)) {
        const direction = baseMove.direction === "horizontal" ? "vertical" : "horizontal";
        const startRow = direction === "horizontal" ? anchor.row : anchor.row - occurrence;
        const startCol = direction === "horizontal" ? anchor.col - occurrence : anchor.col;
        const move = tryPlaceWordAt(game, playerId, word, startRow, startCol, direction);
        if (move) {
          return move;
        }
      }
    }
  }
  return null;
}

function tryPlaceWordAt(
  game: ScrabbleGame,
  playerId: string,
  word: string,
  startRow: number,
  startCol: number,
  direction: Direction
): CandidateMove | null {
  setCurrentPlayer(game, playerId);
  const move = evaluateWordAt(game, playerId, word, startRow, startCol, direction);
  if (!move) {
    return null;
  }
  const result = game.submitMove(playerId, move.placements);
  return result.ok ? move : null;
}

function evaluateWordAt(
  game: ScrabbleGame,
  playerId: string,
  word: string,
  row: number,
  col: number,
  direction: Direction,
  playerOverride?: { rack: Tile[] },
  matchWordToBoardOverride?: internalMatchWord,
  evaluateMoveOverride?: internalEvaluateMove
): CandidateMove | null {
  const player = playerOverride ?? game.getPlayer(playerId);
  if (!player) {
    return null;
  }

  player.rack = createRackFromWord(word);
  const internalGame = game as unknown as InternalScrabbleGame;
  const matchWordToBoard = matchWordToBoardOverride ?? (internalGame.matchWordToBoard.bind(game) as internalMatchWord);
  const evaluateMove = evaluateMoveOverride ?? (internalGame.evaluateMove.bind(game) as internalEvaluateMove);
  const placements = matchWordToBoard(player, word, row, col, direction);
  if (placements.length === 0) {
    return null;
  }
  const evaluation = evaluateMove(playerId, placements);
  if (!evaluation.ok) {
    return null;
  }

  const placementLetters = buildPlacementLetters(word, row, col, direction, placements);
  const placedCells = placements.map((placement) => game.board[placement.row][placement.col]);
  return {
    word,
    placements,
    direction,
    startRow: row,
    startCol: col,
    score: evaluation.value.totalScore,
    crossWordsCount: Math.max(0, evaluation.value.formedWords.length - 1),
    bonusCellsUsed: placedCells.map((cell) => benchmarkTokenForBonus(cell.bonus)).filter((token) => token !== "_"),
    localConstraintScore: computeLocalConstraintScore(game.board, placements),
    placementLetters
  };
}

function createControlledGame(dictionary: Dictionary): ScrabbleGame {
  const seats: PlayerSeat[] = [
    createSeat("p1", 0),
    createSeat("p2", 1)
  ];
  const game = new ScrabbleGame("bench", dictionary, seats);
  const mutable = game as unknown as {
    started: boolean;
    tileBag: Tile[];
    currentPlayerIndex: number;
  };
  mutable.started = true;
  mutable.tileBag = [];
  mutable.currentPlayerIndex = 0;
  return game;
}

function createSeat(id: string, seatIndex: number): PlayerSeat {
  return {
    id,
    seatIndex,
    enabled: true,
    kind: "human",
    name: id,
    ownerClientId: id,
    connected: true,
    score: 0,
    rackCount: 0,
    isCurrentTurn: seatIndex === 0
  };
}

function setCurrentPlayer(game: ScrabbleGame, playerId: string): void {
  const index = game.players.findIndex((player) => player.id === playerId);
  if (index >= 0) {
    (game as unknown as { currentPlayerIndex: number }).currentPlayerIndex = index;
  }
}

let tileCounter = 0;

function createRackFromWord(word: string): Tile[] {
  return word.split("").map((letter) => ({
    id: `bench_${tileCounter += 1}`,
    letter,
    value: LETTER_DISTRIBUTION[letter]?.value ?? 1,
    blank: false
  }));
}

function scoreWord(word: string): number {
  const uniqueBonus = new Set(word).size === word.length ? 0.8 : 0;
  return word.split("").reduce((total, letter) => total + (LETTER_COMMONNESS[letter] ?? 0), 0) + uniqueBonus - word.length * 0.05;
}

function scoreSeedMove(move: CandidateMove, difficulty: BenchmarkDifficulty): number {
  const config = DIFFICULTY_CONFIG[difficulty];
  return (
    move.score +
    move.crossWordsCount * 6 +
    move.bonusCellsUsed.length * (config.requireBonus ? 10 : 4) +
    move.localConstraintScore * (difficulty === "hard" ? 4 : 2)
  );
}

function pickWordSlice(pool: string[], size: number, random: () => number): string[] {
  if (pool.length <= size) {
    return [...pool];
  }
  const start = randomInt(random, 0, Math.max(0, pool.length - size));
  return pool.slice(start, start + size);
}

function pickWordByLengths(pool: string[], lengths: number[], random: () => number): string | null {
  const candidates = pool.filter((word) => lengths.includes(word.length));
  if (candidates.length === 0) {
    return null;
  }
  return candidates[randomInt(random, 0, candidates.length - 1)] ?? null;
}

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function boardToBenchmarkMatrix(board: BoardCell[][]): string[][] {
  return board.map((row) =>
    row.map((cell) => {
      if (cell.tile) {
        return cell.tile.blank ? cell.tile.assignedLetter ?? "" : cell.tile.letter;
      }
      return benchmarkTokenForBonus(cell.bonus);
    })
  );
}

function applyPlacementsToMatrix(
  board: string[][],
  placements: PlacementInput[],
  placementLetters: Record<string, string>
): string[][] {
  const next = board.map((row) => [...row]);
  for (const placement of placements) {
    next[placement.row][placement.col] = placementLetters[coordKey(placement.row, placement.col)] ?? "";
  }
  return next;
}

function benchmarkTokenForBonus(bonus: BoardCell["bonus"]): string {
  switch (bonus) {
    case "dl":
      return "2l";
    case "tl":
      return "3l";
    case "dw":
    case "center":
      return "2w";
    case "tw":
      return "3w";
    default:
      return "_";
  }
}

function getBoardOccupancy(board: BoardCell[][]): number {
  const occupied = board.flat().filter((cell) => Boolean(cell.tile)).length;
  return occupied / (BOARD_SIZE * BOARD_SIZE);
}

function computeLocalConstraintScore(board: BoardCell[][], placements: PlacementInput[]): number {
  const placementKeys = new Set(placements.map((placement) => `${placement.row}:${placement.col}`));
  let total = 0;

  for (const placement of placements) {
    const neighbors = [
      [placement.row - 1, placement.col],
      [placement.row + 1, placement.col],
      [placement.row, placement.col - 1],
      [placement.row, placement.col + 1]
    ];
    for (const [row, col] of neighbors) {
      if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        total += 1;
        continue;
      }
      if (placementKeys.has(`${row}:${col}`)) {
        continue;
      }
      if (board[row][col].tile) {
        total += 1;
      }
    }
  }

  return total;
}

function serializePlacements(placements: PlacementInput[], placementLetters: Record<string, string>): string {
  return [...placements]
    .sort((left, right) => left.row - right.row || left.col - right.col)
    .map((placement) => `${placement.row}:${placement.col}:${placementLetters[coordKey(placement.row, placement.col)] ?? ""}`)
    .join("|");
}

function serializeCandidate(candidate: CandidateMove | undefined): string {
  if (!candidate) {
    return "";
  }
  return serializePlacements(candidate.placements, candidate.placementLetters);
}

function buildPlacementLetters(
  word: string,
  startRow: number,
  startCol: number,
  direction: Direction,
  placements: PlacementInput[]
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const placement of placements) {
    const index = direction === "horizontal" ? placement.col - startCol : placement.row - startRow;
    mapping[coordKey(placement.row, placement.col)] = word[index] ?? "";
  }
  return mapping;
}

function coordKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function findOccurrences(word: string, letter: string): number[] {
  const occurrences: number[] = [];
  for (let index = 0; index < word.length; index += 1) {
    if (word[index] === letter) {
      occurrences.push(index);
    }
  }
  return occurrences;
}

function findUniqueSharedLetters(left: string, right: string): string[] {
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const letter of left) {
    leftCounts.set(letter, (leftCounts.get(letter) ?? 0) + 1);
  }
  for (const letter of right) {
    rightCounts.set(letter, (rightCounts.get(letter) ?? 0) + 1);
  }
  return [...leftCounts.keys()].filter((letter) => leftCounts.get(letter) === 1 && rightCounts.get(letter) === 1);
}

function getOccupiedCells(board: BoardCell[][]): Array<{ row: number; col: number; letter: string }> {
  const occupied: Array<{ row: number; col: number; letter: string }> = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const tile = board[row][col].tile;
      if (tile) {
        occupied.push({
          row,
          col,
          letter: tile.blank ? tile.assignedLetter ?? "" : tile.letter
        });
      }
    }
  }
  return occupied;
}

function getWordCells(word: string, startRow: number, startCol: number, direction: Direction): Array<{ row: number; col: number; letter: string }> {
  return word.split("").map((letter, index) => ({
    row: direction === "horizontal" ? startRow : startRow + index,
    col: direction === "horizontal" ? startCol + index : startCol,
    letter
  }));
}

function fitsOnBoard(startRow: number, startCol: number, length: number, direction: Direction): boolean {
  const endRow = direction === "horizontal" ? startRow : startRow + length - 1;
  const endCol = direction === "horizontal" ? startCol + length - 1 : startCol;
  return startRow >= 0 && startCol >= 0 && endRow < BOARD_SIZE && endCol < BOARD_SIZE;
}

function stampWordOnBoard(board: BoardCell[][], word: string, startRow: number, startCol: number, direction: Direction): void {
  if (!fitsOnBoard(startRow, startCol, word.length, direction)) {
    return;
  }
  for (const cell of getWordCells(word, startRow, startCol, direction)) {
    board[cell.row][cell.col].tile = {
      id: `seed_${cell.row}_${cell.col}_${word}`,
      letter: cell.letter,
      value: LETTER_DISTRIBUTION[cell.letter]?.value ?? 1,
      blank: false
    };
  }
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(random, 0, index);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function createRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}
