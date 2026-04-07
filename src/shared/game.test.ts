import { describe, expect, it } from "vitest";
import { Dictionary } from "./dictionary";
import { ScrabbleGame } from "./game";
import type { PlayerSeat, Tile } from "./types";

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
    isCurrentTurn: false
  };
}

function tile(id: string, letter: string, value = 1): Tile {
  return {
    id,
    letter,
    value,
    blank: false
  };
}

describe("ScrabbleGame", () => {
  it("rejects a first move that does not touch the center", () => {
    const game = new ScrabbleGame("test", new Dictionary("AI"), [createSeat("p1", 0), createSeat("p2", 1)]);
    game.start();
    const player = game.getPlayer("p1");
    if (!player) {
      throw new Error("missing player");
    }
    player.rack = [tile("a1", "A"), tile("i1", "I")];

    const result = game.submitMove("p1", [
      { row: 0, col: 0, tileId: "a1" },
      { row: 0, col: 1, tileId: "i1" }
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("case centrale");
    }
  });

  it("scores the first move with the center multiplier", () => {
    const game = new ScrabbleGame("test", new Dictionary("AI"), [createSeat("p1", 0), createSeat("p2", 1)]);
    game.start();
    const player = game.getPlayer("p1");
    if (!player) {
      throw new Error("missing player");
    }
    player.rack = [tile("a1", "A"), tile("i1", "I")];

    const result = game.submitMove("p1", [
      { row: 7, col: 7, tileId: "a1" },
      { row: 7, col: 8, tileId: "i1" }
    ]);

    expect(result.ok).toBe(true);
    const snapshot = game.getSnapshot("p1");
    expect(snapshot.players[0].score).toBe(4);
    expect(snapshot.board[7][7].tile?.letter).toBe("A");
    expect(snapshot.board[7][8].tile?.letter).toBe("I");
  });

  it("generates legal moves that connect to the existing board", () => {
    const game = new ScrabbleGame("test", new Dictionary("AI\nAIR"), [createSeat("p1", 0), createSeat("p2", 1)]);
    game.start();
    const player1 = game.getPlayer("p1");
    const player2 = game.getPlayer("p2");
    if (!player1 || !player2) {
      throw new Error("missing players");
    }

    player1.rack = [tile("a1", "A"), tile("i1", "I")];
    let result = game.submitMove("p1", [
      { row: 7, col: 7, tileId: "a1" },
      { row: 7, col: 8, tileId: "i1" }
    ]);
    expect(result.ok).toBe(true);

    player2.rack = [tile("r1", "R")];
    const moves = game.listLegalMoves("p2", 5);

    expect(moves.some((move: { formedWords: string[] }) => move.formedWords.includes("AIR"))).toBe(true);
  });

  it("reports invalid words with their board coordinates", () => {
    const game = new ScrabbleGame("test", new Dictionary("AI"), [createSeat("p1", 0), createSeat("p2", 1)]);
    game.start();
    const player1 = game.getPlayer("p1");
    const player2 = game.getPlayer("p2");
    if (!player1 || !player2) {
      throw new Error("missing players");
    }

    player1.rack = [tile("a1", "A"), tile("i1", "I")];
    const opening = game.submitMove("p1", [
      { row: 7, col: 7, tileId: "a1" },
      { row: 7, col: 8, tileId: "i1" }
    ]);
    expect(opening.ok).toBe(true);

    player2.rack = [tile("z1", "Z")];
    const result = game.submitMove("p2", [{ row: 7, col: 9, tileId: "z1" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mot(s) invalide(s)");
      expect(result.error).toContain("AIZ");
      expect(result.error).toContain("8,8");
      expect(result.error).toContain("8,10");
    }
  });

  it("reports floating moves explicitly", () => {
    const game = new ScrabbleGame("test", new Dictionary("AI\nAIR"), [createSeat("p1", 0), createSeat("p2", 1)]);
    game.start();
    const player1 = game.getPlayer("p1");
    const player2 = game.getPlayer("p2");
    if (!player1 || !player2) {
      throw new Error("missing players");
    }

    player1.rack = [tile("a1", "A"), tile("i1", "I")];
    const opening = game.submitMove("p1", [
      { row: 7, col: 7, tileId: "a1" },
      { row: 7, col: 8, tileId: "i1" }
    ]);
    expect(opening.ok).toBe(true);

    player2.rack = [tile("r1", "R")];
    const result = game.submitMove("p2", [{ row: 0, col: 0, tileId: "r1" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Coup flottant");
      expect(result.error).toContain("1,1");
    }
  });
});
