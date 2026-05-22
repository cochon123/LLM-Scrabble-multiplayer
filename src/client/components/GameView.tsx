import type { BoardCell, LegalMove, PlacementInput, RoomView, Tile } from "../../shared/types";
import { BoardGrid, RackTile } from "./Board";
import { LegalMoveCard } from "./shared";

export function GameView({
  view,
  error,
  myTurn,
  myRack,
  tentativePlacements,
  setTentativePlacements,
  selectedTileId,
  draggedTileId,
  setDraggedTileId,
  setSelectedTileId,
  exchangeSelection,
  setExchangeSelection,
  onBoardClick,
  onDropTile,
  onRemoveTile,
  submitMove,
  clearDraftMove,
  passTurn,
  exchangeTiles,
  showLegalMovesFeature,
  showLegalMovesPanel,
  toggleLegalMovesPanel,
  requestLegalMoves,
  legalMoves
}: {
  view: RoomView;
  error: string;
  myTurn: boolean;
  myRack: Tile[];
  tentativePlacements: PlacementInput[];
  setTentativePlacements: React.Dispatch<React.SetStateAction<PlacementInput[]>>;
  selectedTileId: string | null;
  draggedTileId: string | null;
  setDraggedTileId: (tileId: string | null) => void;
  setSelectedTileId: (tileId: string | null) => void;
  exchangeSelection: string[];
  setExchangeSelection: React.Dispatch<React.SetStateAction<string[]>>;
  onBoardClick: (cell: BoardCell) => void;
  onDropTile: (tileId: string, cell: BoardCell) => void;
  onRemoveTile: (placement: PlacementInput) => void;
  submitMove: () => void;
  clearDraftMove: () => void;
  passTurn: () => void;
  exchangeTiles: () => void;
  showLegalMovesFeature: boolean;
  showLegalMovesPanel: boolean;
  toggleLegalMovesPanel: () => void;
  requestLegalMoves: () => void;
  legalMoves: LegalMove[];
}) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-indigo-500">Game</p>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Turn {view.game.turn}</h2>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <p className="text-slate-600 dark:text-slate-300">
          {view.game.players.find((player) => player.id === view.game.currentPlayerId)?.name ?? "Waiting"}
          {view.paused ? " · Paused" : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          onClick={submitMove}
          disabled={!myTurn || tentativePlacements.length === 0}
        >
          Play
        </button>
        <button
          className="rounded-xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={clearDraftMove}
          disabled={tentativePlacements.length === 0}
        >
          Clear
        </button>
        <button
          className="rounded-xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={passTurn}
          disabled={!myTurn}
        >
          Pass
        </button>
      </div>

      {error ? <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-400">{error}</div> : null}

      <div className="rounded-xl bg-slate-50 dark:bg-slate-950 p-4">
        <BoardGrid
          board={view.game.board}
          tentativePlacements={tentativePlacements}
          myRack={myRack}
          myTurn={myTurn}
          onClickCell={onBoardClick}
          onDropTile={onDropTile}
          onStartDraggingTile={setDraggedTileId}
          draggedTileId={draggedTileId}
          onRemoveTile={onRemoveTile}
        />
      </div>

      <div
        className={`rounded-xl bg-slate-50 dark:bg-slate-950 p-4 transition-all ${
          myTurn && draggedTileId && tentativePlacements.some((p) => p.tileId === draggedTileId)
            ? "ring-4 ring-dashed ring-orange-400 bg-orange-50 dark:bg-orange-950/20"
            : ""
        }`}
        onDragOver={(event) => {
          if (myTurn && draggedTileId) {
            const isBoardTile = tentativePlacements.some((p) => p.tileId === draggedTileId);
            if (isBoardTile) {
              event.preventDefault();
            }
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!myTurn || !draggedTileId) return;

          const placement = tentativePlacements.find((p) => p.tileId === draggedTileId);
          if (placement) {
            onRemoveTile(placement);
            setDraggedTileId(null);
          }
        }}
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">Rack</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Drag and drop tiles to think visually. Right-click to prepare an exchange.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {showLegalMovesFeature ? (
              <button
                className="rounded-xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={toggleLegalMovesPanel}
                disabled={!myTurn}
              >
                {showLegalMovesPanel ? "Hide legal moves" : "Show legal moves"}
              </button>
            ) : null}
            <button
              className="rounded-xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={exchangeTiles}
              disabled={!myTurn || exchangeSelection.length === 0}
            >
              Exchange ({exchangeSelection.length})
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {myRack.map((tile) => (
            <RackTile
              key={tile.id}
              tile={tile}
              disabled={!myTurn}
              selected={selectedTileId === tile.id}
              exchange={exchangeSelection.includes(tile.id)}
              onSelect={() => setSelectedTileId(selectedTileId === tile.id ? null : tile.id)}
              onToggleExchange={() =>
                setExchangeSelection((current) =>
                  current.includes(tile.id) ? current.filter((id) => id !== tile.id) : [...current, tile.id]
                )
              }
              onDragStart={() => setDraggedTileId(tile.id)}
              onDragEnd={() => setDraggedTileId(null)}
            />
          ))}
        </div>
      </div>

      {showLegalMovesFeature && showLegalMovesPanel ? (
        <section className="rounded-xl bg-slate-50 dark:bg-slate-950 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Legal moves</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Compact grid. Click a card to prepare the move.</p>
            </div>
            <button className="rounded-xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800" onClick={requestLegalMoves} disabled={!myTurn}>
              Refresh
            </button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {legalMoves.map((move) => (
              <LegalMoveCard
                key={`${move.summary}-${move.score}`}
                move={move}
                onApply={() => {
                  setTentativePlacements(move.placements);
                  setSelectedTileId(null);
                  setDraggedTileId(null);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
