import { nanoid } from "nanoid";
import { BOARD_SIZE, CENTER, LETTER_DISTRIBUTION, RACK_SIZE, getBonus } from "./constants.js";
import { Dictionary } from "./dictionary.js";
import type {
  BoardCell,
  Coord,
  Direction,
  GameSnapshot,
  LegalMove,
  PlacementInput,
  PlayerSeat,
  Tile,
  TurnLog
} from "./types.js";

interface PlayerState {
  id: string;
  seatIndex: number;
  kind: "human" | "agent";
  name: string;
  rack: Tile[];
  score: number;
  ownerClientId?: string | null;
  connected: boolean;
  agentConfig?: PlayerSeat["agentConfig"];
}

interface MoveWord {
  word: string;
  score: number;
  coords: Coord[];
}

interface MoveEvaluation {
  placements: PlacementInput[];
  placedTiles: Array<BoardCell & { tile: Tile }>;
  formedWords: MoveWord[];
  totalScore: number;
}

export class ScrabbleGame {
  readonly id: string;
  readonly dictionary: Dictionary;
  readonly board: BoardCell[][];
  readonly players: PlayerState[];
  private tileBag: Tile[];
  private currentPlayerIndex = 0;
  private turn = 1;
  private scorelessTurns = 0;
  private started = false;
  private finished = false;
  private winnerIds: string[] = [];
  private lastMove?: TurnLog;

  constructor(id: string, dictionary: Dictionary, seats: PlayerSeat[]) {
    this.id = id;
    this.dictionary = dictionary;
    this.board = createBoard();
    this.players = seats.map((seat) => ({
      id: seat.id,
      seatIndex: seat.seatIndex,
      kind: seat.kind,
      name: seat.name,
      rack: [],
      score: 0,
      ownerClientId: seat.ownerClientId,
      connected: seat.connected,
      agentConfig: seat.agentConfig
    }));
    this.tileBag = createTileBag();
  }

  start(): void {
    if (this.started) {
      return;
    }

    for (const player of this.players) {
      this.refillRack(player);
    }

    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  isFinished(): boolean {
    return this.finished;
  }

  getCurrentPlayer(): PlayerState | null {
    return this.players[this.currentPlayerIndex] ?? null;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.find((player) => player.id === playerId);
  }

  getSnapshot(viewerPlayerId?: string | null): GameSnapshot {
    return {
      id: this.id,
      board: this.board.map((row) =>
        row.map((cell) => ({
          ...cell,
          tile: cell.tile ? { ...cell.tile } : null
        }))
      ),
      players: this.players.map((player) => ({
        id: player.id,
        seatIndex: player.seatIndex,
        enabled: true,
        kind: player.kind,
        name: player.name,
        ownerClientId: player.ownerClientId,
        connected: player.connected,
        score: player.score,
        rackCount: player.rack.length,
        rack: player.id === viewerPlayerId ? player.rack.map((tile) => ({ ...tile })) : undefined,
        isCurrentTurn: this.getCurrentPlayer()?.id === player.id,
        agentConfig: player.agentConfig
      })),
      currentPlayerId: this.getCurrentPlayer()?.id ?? null,
      turn: this.turn,
      bagCount: this.tileBag.length,
      scorelessTurns: this.scorelessTurns,
      started: this.started,
      finished: this.finished,
      winnerIds: [...this.winnerIds],
      lastMove: this.lastMove
    };
  }

  listLegalMoves(playerId: string, limit = 12): LegalMove[] {
    const player = this.getPlayer(playerId);
    if (!player || this.finished || this.getCurrentPlayer()?.id !== playerId) {
      return [];
    }

    const moves = new Map<string, LegalMove>();
    for (const word of this.dictionary.getWords()) {
      for (const direction of ["horizontal", "vertical"] as const) {
        const maxRow = direction === "horizontal" ? BOARD_SIZE : BOARD_SIZE - word.length + 1;
        const maxCol = direction === "horizontal" ? BOARD_SIZE - word.length + 1 : BOARD_SIZE;

        for (let row = 0; row < maxRow; row += 1) {
          for (let col = 0; col < maxCol; col += 1) {
            const placements = this.matchWordToBoard(player, word, row, col, direction);
            if (placements.length === 0) {
              continue;
            }

            const evaluation = this.evaluateMove(playerId, placements);
            if (!evaluation.ok) {
              continue;
            }

            const moveKey = serializePlacements(placements);
            if (moves.has(moveKey)) {
              continue;
            }

            moves.set(moveKey, {
              placements,
              score: evaluation.value.totalScore,
              formedWords: evaluation.value.formedWords.map((item) => item.word),
              summary: `${word} ${direction === "horizontal" ? "→" : "↓"} ${row + 1},${col + 1} (${evaluation.value.totalScore} pts)`
            });
          }
        }
      }
    }

    return [...moves.values()]
      .sort((left, right) => right.score - left.score || right.formedWords[0].length - left.formedWords[0].length)
      .slice(0, limit);
  }

  submitMove(playerId: string, placements: PlacementInput[]): { ok: true; move: TurnLog } | { ok: false; error: string } {
    const evaluation = this.evaluateMove(playerId, placements);
    if (!evaluation.ok) {
      return evaluation;
    }

    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, error: "Joueur introuvable." };
    }

    for (const placement of evaluation.value.placedTiles) {
      this.board[placement.row][placement.col].tile = placement.tile;
    }

    for (const placement of placements) {
      const tileIndex = player.rack.findIndex((tile) => tile.id === placement.tileId);
      if (tileIndex >= 0) {
        player.rack.splice(tileIndex, 1);
      }
    }

    player.score += evaluation.value.totalScore;
    this.refillRack(player);
    this.turn += 1;
    this.scorelessTurns = 0;

    const mainWord = evaluation.value.formedWords[0]?.word ?? "COUP";
    const move: TurnLog = {
      id: nanoid(),
      playerId,
      playerName: player.name,
      action: "play",
      summary: `${mainWord} pour ${evaluation.value.totalScore} points`,
      scoreDelta: evaluation.value.totalScore,
      createdAt: Date.now()
    };
    this.lastMove = move;

    this.advanceTurn();
    this.tryFinish(player);

    return { ok: true, move };
  }

  exchangeTiles(playerId: string, tileIds: string[]): { ok: true; move: TurnLog } | { ok: false; error: string } {
    const player = this.getPlayer(playerId);
    if (!player || this.getCurrentPlayer()?.id !== playerId) {
      return { ok: false, error: "Ce n'est pas votre tour." };
    }
    if (this.tileBag.length < tileIds.length) {
      return { ok: false, error: "Le sac ne contient pas assez de lettres pour un échange." };
    }

    const removed: Tile[] = [];
    for (const tileId of tileIds) {
      const tileIndex = player.rack.findIndex((tile) => tile.id === tileId);
      if (tileIndex === -1) {
        return { ok: false, error: "Une des tuiles sélectionnées n'est pas dans votre chevalet." };
      }
      removed.push(player.rack.splice(tileIndex, 1)[0]);
    }

    this.tileBag.push(...removed);
    shuffleInPlace(this.tileBag);
    this.refillRack(player);

    this.turn += 1;
    this.scorelessTurns += 1;
    const move: TurnLog = {
      id: nanoid(),
      playerId,
      playerName: player.name,
      action: "exchange",
      summary: `${tileIds.length} tuile(s) échangée(s)`,
      scoreDelta: 0,
      createdAt: Date.now()
    };
    this.lastMove = move;
    this.advanceTurn();
    this.tryFinish();
    return { ok: true, move };
  }

  pass(playerId: string): { ok: true; move: TurnLog } | { ok: false; error: string } {
    const player = this.getPlayer(playerId);
    if (!player || this.getCurrentPlayer()?.id !== playerId) {
      return { ok: false, error: "Ce n'est pas votre tour." };
    }

    this.turn += 1;
    this.scorelessTurns += 1;
    const move: TurnLog = {
      id: nanoid(),
      playerId,
      playerName: player.name,
      action: "pass",
      summary: "Passe son tour",
      scoreDelta: 0,
      createdAt: Date.now()
    };
    this.lastMove = move;
    this.advanceTurn();
    this.tryFinish();
    return { ok: true, move };
  }

  private matchWordToBoard(
    player: PlayerState,
    word: string,
    row: number,
    col: number,
    direction: Direction
  ): PlacementInput[] {
    const availableTiles = player.rack.map((tile) => ({ ...tile }));
    const placements: PlacementInput[] = [];
    let touchesExisting = false;

    for (let index = 0; index < word.length; index += 1) {
      const currentRow = direction === "horizontal" ? row : row + index;
      const currentCol = direction === "horizontal" ? col + index : col;
      const cell = this.board[currentRow][currentCol];
      const letter = word[index];

      if (cell.tile) {
        if (tileFace(cell.tile) !== letter) {
          return [];
        }
        touchesExisting = true;
        continue;
      }

      const tileIndex = availableTiles.findIndex((tile) => !tile.blank && tileFace(tile) === letter);
      const blankIndex = availableTiles.findIndex((tile) => tile.blank);
      const pickedIndex = tileIndex >= 0 ? tileIndex : blankIndex;
      if (pickedIndex === -1) {
        return [];
      }
      const tile = availableTiles.splice(pickedIndex, 1)[0];
      placements.push({
        row: currentRow,
        col: currentCol,
        tileId: tile.id,
        letter: tile.blank ? letter : undefined
      });
    }

    if (placements.length === 0) {
      return [];
    }

    if (!this.isBoardEmpty() && !touchesExisting) {
      const connected = placements.some((placement) => hasNeighborTile(this.board, placement.row, placement.col));
      if (!connected) {
        return [];
      }
    }

    return placements;
  }

  private evaluateMove(
    playerId: string,
    placements: PlacementInput[]
  ): { ok: true; value: MoveEvaluation } | { ok: false; error: string } {
    if (!this.started) {
      return { ok: false, error: "La partie n'a pas commencé." };
    }
    if (this.finished) {
      return { ok: false, error: "La partie est terminée." };
    }
    if (this.getCurrentPlayer()?.id !== playerId) {
      return { ok: false, error: "Ce n'est pas votre tour." };
    }
    if (placements.length === 0) {
      return { ok: false, error: "Aucune tuile n'a été placée." };
    }

    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, error: "Joueur introuvable." };
    }

    const placementKeys = new Set<string>();
    const placedTiles: Array<BoardCell & { tile: Tile }> = [];
    const usedTileIds = new Set<string>();

    for (const placement of placements) {
      const key = `${placement.row}:${placement.col}`;
      if (placementKeys.has(key)) {
        return { ok: false, error: `Plusieurs tuiles visent la case ${formatCoord(placement.row, placement.col)}.` };
      }
      placementKeys.add(key);

      if (!isWithinBoard(placement.row, placement.col)) {
        return { ok: false, error: `La case ${formatCoord(placement.row, placement.col)} sort du plateau 15x15.` };
      }
      if (this.board[placement.row][placement.col].tile) {
        const existing = this.board[placement.row][placement.col].tile;
        return {
          ok: false,
          error: `La case ${formatCoord(placement.row, placement.col)} contient déjà ${existing ? tileFace(existing) : "une tuile"}.`
        };
      }
      if (usedTileIds.has(placement.tileId)) {
        return { ok: false, error: `La même tuile est utilisée plusieurs fois, notamment en ${formatCoord(placement.row, placement.col)}.` };
      }
      usedTileIds.add(placement.tileId);

      const rackTile = player.rack.find((tile) => tile.id === placement.tileId);
      if (!rackTile) {
        return {
          ok: false,
          error: `La tuile envoyée pour ${formatCoord(placement.row, placement.col)} n'appartient pas au chevalet du joueur.`
        };
      }

      const tile: Tile = rackTile.blank
        ? {
            ...rackTile,
            assignedLetter: this.dictionary.normalize(placement.letter ?? "").slice(0, 1)
          }
        : { ...rackTile };

      if (tile.blank && !tile.assignedLetter) {
        return { ok: false, error: `Le joker placé en ${formatCoord(placement.row, placement.col)} doit recevoir une lettre.` };
      }

      placedTiles.push({
        ...this.board[placement.row][placement.col],
        row: placement.row,
        col: placement.col,
        tile
      });
    }

    const rows = new Set(placements.map((placement) => placement.row));
    const cols = new Set(placements.map((placement) => placement.col));
    let direction: Direction | null = null;

    if (placements.length > 1) {
      if (rows.size === 1) {
        direction = "horizontal";
      } else if (cols.size === 1) {
        direction = "vertical";
      } else {
        return {
          ok: false,
          error: `Les tuiles doivent être alignées. Placements reçus: ${formatPlacementCoords(placements)}.`
        };
      }
    }

    if (direction) {
      const sorted = [...placements].sort((left, right) =>
        direction === "horizontal" ? left.col - right.col : left.row - right.row
      );
      const fixedIndex = direction === "horizontal" ? sorted[0].row : sorted[0].col;
      const start = direction === "horizontal" ? sorted[0].col : sorted[0].row;
      const end = direction === "horizontal" ? sorted[sorted.length - 1].col : sorted[sorted.length - 1].row;

      for (let cursor = start; cursor <= end; cursor += 1) {
        const row = direction === "horizontal" ? fixedIndex : cursor;
        const col = direction === "horizontal" ? cursor : fixedIndex;
        if (!this.cellHasTileAfterPlacements(row, col, placedTiles)) {
          return {
            ok: false,
            error: `Le mot principal contient un trou en ${formatCoord(row, col)} entre ${formatCoord(sorted[0].row, sorted[0].col)} et ${formatCoord(sorted[sorted.length - 1].row, sorted[sorted.length - 1].col)}.`
          };
        }
      }
    }

    if (this.isBoardEmpty()) {
      const reachesCenter = placements.some((placement) => placement.row === CENTER.row && placement.col === CENTER.col);
      if (!reachesCenter) {
        return {
          ok: false,
          error: `Le premier coup doit couvrir la case centrale ${formatCoord(CENTER.row, CENTER.col)}. Les coordonnées des outils sont 0-indexées.`
        };
      }
    } else {
      const touchesExisting = placedTiles.some((placement) => hasNeighborTile(this.board, placement.row, placement.col));
      if (!touchesExisting) {
        return {
          ok: false,
          error: `Coup flottant: aucune tuile posée ne touche un mot existant. Placements reçus: ${formatPlacementCoords(placements)}.`
        };
      }
    }

    const formedWords: MoveWord[] = [];
    if (direction) {
      const mainWord = this.buildWord(placedTiles[0], direction, placedTiles);
      if (!mainWord || mainWord.word.length === 0) {
        return { ok: false, error: "Le mot principal n'a pas pu être reconstruit." };
      }
      formedWords.push(mainWord);
      const crossDirection = direction === "horizontal" ? "vertical" : "horizontal";
      for (const placedTile of placedTiles) {
        const crossWord = this.buildWord(placedTile, crossDirection, placedTiles);
        if (crossWord && crossWord.word.length > 1) {
          formedWords.push(crossWord);
        }
      }
    } else {
      const horizontalWord = this.buildWord(placedTiles[0], "horizontal", placedTiles);
      const verticalWord = this.buildWord(placedTiles[0], "vertical", placedTiles);
      if (horizontalWord && horizontalWord.word.length > 1) {
        formedWords.push(horizontalWord);
      }
      if (verticalWord && verticalWord.word.length > 1) {
        formedWords.push(verticalWord);
      }
      if (formedWords.length === 0) {
        formedWords.push(this.buildSingleLetterWord(placedTiles[0]));
      }
    }

    const uniqueWords = dedupeWords(formedWords);
    const invalidWords = uniqueWords.filter((word) => !this.dictionary.has(word.word));
    if (invalidWords.length > 0) {
      return {
        ok: false,
        error: `Mot(s) invalide(s): ${invalidWords.map((word) => formatWordWithCoords(word)).join(" ; ")}`
      };
    }

    return {
      ok: true,
      value: {
        placements,
        placedTiles,
        formedWords: uniqueWords,
        totalScore: uniqueWords.reduce((total, word) => total + word.score, 0) + (placements.length === 7 ? 50 : 0)
      }
    };
  }

  private buildSingleLetterWord(cell: BoardCell & { tile: Tile }): MoveWord {
    const letterValue = cell.tile.value;
    const wordMultiplier = cell.bonus === "dw" || cell.bonus === "center" ? 2 : cell.bonus === "tw" ? 3 : 1;
    const letterMultiplier = cell.bonus === "dl" ? 2 : cell.bonus === "tl" ? 3 : 1;

    return {
      word: tileFace(cell.tile),
      score: letterValue * letterMultiplier * wordMultiplier,
      coords: [{ row: cell.row, col: cell.col }]
    };
  }

  private buildWord(
    origin: BoardCell & { tile: Tile },
    direction: Direction,
    placedTiles: Array<BoardCell & { tile: Tile }>
  ): MoveWord | null {
    const deltaRow = direction === "horizontal" ? 0 : 1;
    const deltaCol = direction === "horizontal" ? 1 : 0;
    let row = origin.row;
    let col = origin.col;

    while (this.cellHasTileAfterPlacements(row - deltaRow, col - deltaCol, placedTiles)) {
      row -= deltaRow;
      col -= deltaCol;
    }

    let word = "";
    let score = 0;
    let multiplier = 1;
    const coords: Coord[] = [];

    while (this.cellHasTileAfterPlacements(row, col, placedTiles)) {
      const existingCell = this.board[row][col];
      const placedTile = placedTiles.find((cell) => cell.row === row && cell.col === col);
      const tile = placedTile?.tile ?? existingCell.tile;
      if (!tile) {
        break;
      }

      const isNewTile = Boolean(placedTile);
      const letter = tileFace(tile);
      let letterScore = tile.value;
      if (isNewTile) {
        if (existingCell.bonus === "dl") {
          letterScore *= 2;
        } else if (existingCell.bonus === "tl") {
          letterScore *= 3;
        }

        if (existingCell.bonus === "dw" || existingCell.bonus === "center") {
          multiplier *= 2;
        } else if (existingCell.bonus === "tw") {
          multiplier *= 3;
        }
      }

      word += letter;
      score += letterScore;
      coords.push({ row, col });
      row += deltaRow;
      col += deltaCol;
    }

    return {
      word,
      score: score * multiplier,
      coords
    };
  }

  private cellHasTileAfterPlacements(
    row: number,
    col: number,
    placedTiles: Array<BoardCell & { tile: Tile }>
  ): boolean {
    if (!isWithinBoard(row, col)) {
      return false;
    }
    return Boolean(this.board[row][col].tile || placedTiles.some((cell) => cell.row === row && cell.col === col));
  }

  private isBoardEmpty(): boolean {
    return this.board.every((row) => row.every((cell) => !cell.tile));
  }

  private refillRack(player: PlayerState): void {
    while (player.rack.length < RACK_SIZE && this.tileBag.length > 0) {
      const nextTile = this.tileBag.shift();
      if (nextTile) {
        player.rack.push(nextTile);
      }
    }
  }

  private advanceTurn(): void {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
  }

  private tryFinish(finisher?: PlayerState): void {
    if (this.finished) {
      return;
    }
    const endedByRack = Boolean(finisher && this.tileBag.length === 0 && finisher.rack.length === 0);
    const endedByStall = this.scorelessTurns >= this.players.length * 2;

    if (!endedByRack && !endedByStall) {
      return;
    }

    this.finished = true;
    let bonusPool = 0;
    for (const player of this.players) {
      const remaining = player.rack.reduce((total, tile) => total + tile.value, 0);
      player.score -= remaining;
      bonusPool += remaining;
    }

    if (finisher && finisher.rack.length === 0) {
      finisher.score += bonusPool;
    }

    const bestScore = Math.max(...this.players.map((player) => player.score));
    this.winnerIds = this.players.filter((player) => player.score === bestScore).map((player) => player.id);
  }
}

function createBoard(): BoardCell[][] {
  return Array.from({ length: BOARD_SIZE }, (_, row) =>
    Array.from({ length: BOARD_SIZE }, (_, col) => ({
      row,
      col,
      bonus: getBonus(row, col),
      tile: null
    }))
  );
}

function createTileBag(): Tile[] {
  const tiles: Tile[] = [];
  Object.entries(LETTER_DISTRIBUTION).forEach(([letter, meta]: [string, { count: number; value: number }]) => {
    for (let count = 0; count < meta.count; count += 1) {
      tiles.push({
        id: nanoid(),
        letter: letter === "?" ? "" : letter,
        value: meta.value,
        blank: letter === "?"
      });
    }
  });
  shuffleInPlace(tiles);
  return tiles;
}

function shuffleInPlace<T>(array: T[]): void {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[swapIndex]] = [array[swapIndex], array[index]];
  }
}

function tileFace(tile: Tile): string {
  return (tile.blank ? tile.assignedLetter : tile.letter) ?? "";
}

function isWithinBoard(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function hasNeighborTile(board: BoardCell[][], row: number, col: number): boolean {
  return [
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1]
  ].some(([neighborRow, neighborCol]) => isWithinBoard(neighborRow, neighborCol) && Boolean(board[neighborRow][neighborCol].tile));
}

function dedupeWords(words: MoveWord[]): MoveWord[] {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = `${word.word}:${word.coords.map((coord) => `${coord.row},${coord.col}`).join("|")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function serializePlacements(placements: PlacementInput[]): string {
  return [...placements]
    .sort((left, right) => left.row - right.row || left.col - right.col)
    .map((placement) => `${placement.row}:${placement.col}:${placement.tileId}:${placement.letter ?? ""}`)
    .join("|");
}

function formatCoord(row: number, col: number): string {
  return `row ${row}, col ${col} (affichage humain ${row + 1},${col + 1})`;
}

function formatPlacementCoords(placements: PlacementInput[]): string {
  return placements.map((placement) => formatCoord(placement.row, placement.col)).join(", ");
}

function formatWordWithCoords(word: MoveWord): string {
  const start = word.coords[0];
  const end = word.coords[word.coords.length - 1];
  if (!start || !end) {
    return word.word;
  }
  return `${word.word} (${formatCoord(start.row, start.col)} -> ${formatCoord(end.row, end.col)})`;
}
