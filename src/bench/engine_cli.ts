import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BOARD_SIZE, LETTER_DISTRIBUTION } from "../shared/constants.js";
import { Dictionary } from "../shared/dictionary.js";
import { ScrabbleGame } from "../shared/game.js";
import type { PlacementInput, PlayerSeat, Tile } from "../shared/types.js";
import { ensureParentDir, generateDataset, getDefaultDictionaryPath, inspectCase, type BenchmarkCase } from "./case_generator.js";

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(token.slice(2), "true");
      continue;
    }
    parsed.set(token.slice(2), next);
    index += 1;
  }
  return parsed;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === "generate-dataset") {
    const out = args.get("out");
    if (!out) {
      throw new Error("Usage: generate-dataset --out <path> [--count 500 --simple 200 --medium 200 --hard 100 --seed 1]");
    }
    await ensureParentDir(out);
    const cases = await generateDataset({
      count: Number(args.get("count") ?? "500"),
      simple: Number(args.get("simple") ?? "200"),
      medium: Number(args.get("medium") ?? "200"),
      hard: Number(args.get("hard") ?? "100"),
      out,
      seed: Number(args.get("seed") ?? "1"),
      dictionaryPath: args.get("dictionary") ?? getDefaultDictionaryPath()
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        out,
        count: cases.length
      })}\n`
    );
    return;
  }

  if (command === "inspect-case") {
    const dataset = args.get("dataset");
    const caseId = args.get("case-id");
    if (!dataset || !caseId) {
      throw new Error("Usage: inspect-case --dataset <path> --case-id <id>");
    }
    const item = await inspectCase(dataset, caseId);
    if (!item) {
      throw new Error(`Cas introuvable: ${caseId}`);
    }
    process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    return;
  }

  if (command === "evaluate-free-play") {
    const dictionaryPath = args.get("dictionary") ?? getDefaultDictionaryPath();
    const stdin = await readStdin();
    if (!stdin.trim()) {
      throw new Error("evaluate-free-play expects a JSON payload on stdin.");
    }
    const payload = JSON.parse(stdin) as {
      case: BenchmarkCase;
      placements: Array<{ row: number; col: number; letter: string }>;
    };
    const result = await evaluateFreePlay(payload.case, payload.placements, dictionaryPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error("Commande inconnue. Utilisez generate-dataset ou inspect-case.");
}

async function evaluateFreePlay(
  caseData: BenchmarkCase,
  requestedPlacements: Array<{ row: number; col: number; letter: string }>,
  dictionaryPath: string
): Promise<Record<string, unknown>> {
  const dictionaryContent = await readFile(dictionaryPath, "utf8");
  const dictionary = new Dictionary(dictionaryContent);
  const game = createControlledGame(dictionary);
  hydrateBoard(game, caseData.board_before);

  const player = game.getPlayer("p1");
  if (!player) {
    throw new Error("Missing benchmark player.");
  }
  player.rack = createRackFromLetters(caseData.rack);

  const mapped = mapFreePlayPlacements(game, dictionary, player.rack, requestedPlacements);
  if (!mapped.ok) {
    return {
      success: false,
      error: mapped.error,
      predicted_board: boardToBenchmarkMatrix(game.board),
      score: null,
      summary: null,
    };
  }

  const result = game.submitMove("p1", mapped.placements);
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
      predicted_board: boardToBenchmarkMatrix(game.board),
      score: null,
      summary: null,
    };
  }

  return {
    success: true,
    error: null,
    predicted_board: boardToBenchmarkMatrix(game.board),
    score: result.move.scoreDelta,
    summary: result.move.summary,
  };
}

function createControlledGame(dictionary: Dictionary): ScrabbleGame {
  const seats: PlayerSeat[] = [createSeat("p1", 0), createSeat("p2", 1)];
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
    isCurrentTurn: seatIndex === 0,
  };
}

let tileCounter = 0;

function createRackFromLetters(letters: string[]): Tile[] {
  return letters.map((letter) => ({
    id: `free_${tileCounter += 1}`,
    letter,
    value: LETTER_DISTRIBUTION[letter]?.value ?? 1,
    blank: false,
  }));
}

function hydrateBoard(game: ScrabbleGame, boardBefore: string[][]): void {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const token = boardBefore[row]?.[col] ?? "_";
      if (isLetterToken(token)) {
        game.board[row][col].tile = {
          id: `seed_${row}_${col}`,
          letter: token,
          value: LETTER_DISTRIBUTION[token]?.value ?? 1,
          blank: false,
        };
      }
    }
  }
}

function mapFreePlayPlacements(
  game: ScrabbleGame,
  dictionary: Dictionary,
  rack: Tile[],
  requestedPlacements: Array<{ row: number; col: number; letter: string }>
):
  | { ok: true; placements: PlacementInput[] }
  | { ok: false; error: string } {
  const available = [...rack];
  const mapped: PlacementInput[] = [];
  const seen = new Set<string>();

  for (const placement of requestedPlacements) {
    if (!Number.isInteger(placement.row) || !Number.isInteger(placement.col) || typeof placement.letter !== "string") {
      return { ok: false, error: "Malformed placement payload." };
    }
    if (placement.row < 0 || placement.row >= BOARD_SIZE || placement.col < 0 || placement.col >= BOARD_SIZE) {
      return { ok: false, error: `Out of bounds: ${placement.row},${placement.col}` };
    }
    const coord = `${placement.row},${placement.col}`;
    if (seen.has(coord)) {
      return { ok: false, error: `Duplicate coordinate: ${coord}` };
    }
    seen.add(coord);

    const letter = dictionary.normalize(placement.letter).slice(0, 1);
    if (!letter) {
      return { ok: false, error: `Invalid letter: ${placement.letter}` };
    }
    const cell = game.board[placement.row][placement.col];
    if (cell.tile) {
      if (cell.tile.letter !== letter) {
        return { ok: false, error: `Cell already occupied: ${placement.row},${placement.col}` };
      }
      continue;
    }

    const tileIndex = available.findIndex((tile) => tile.letter === letter);
    if (tileIndex === -1) {
      return { ok: false, error: `Letter not in rack: ${letter}` };
    }
    const [tile] = available.splice(tileIndex, 1);
    mapped.push({
      row: placement.row,
      col: placement.col,
      tileId: tile.id,
    });
  }

  if (mapped.length === 0) {
    return { ok: false, error: "No new tiles were provided." };
  }
  return { ok: true, placements: mapped };
}

function boardToBenchmarkMatrix(board: ScrabbleGame["board"]): string[][] {
  return board.map((row) =>
    row.map((cell) => {
      if (cell.tile) {
        return cell.tile.blank ? cell.tile.assignedLetter ?? "" : cell.tile.letter;
      }
      return benchmarkTokenForBonus(cell.bonus);
    })
  );
}

function benchmarkTokenForBonus(bonus: ScrabbleGame["board"][number][number]["bonus"]): string {
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

function isLetterToken(value: string): boolean {
  return value.length === 1 && value.toUpperCase() === value && /[A-Z]/.test(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
