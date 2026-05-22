import { useState } from "react";
import type { BoardCell, PlacementInput, Tile } from "../../shared/types";
import { bonusClasses, bonusLabelClasses, labelBonus } from "../lib/helpers";

export function BoardGrid({
  board,
  tentativePlacements,
  myRack,
  myTurn,
  onClickCell,
  onDropTile,
  onStartDraggingTile,
  draggedTileId,
  onRemoveTile
}: {
  board: BoardCell[][];
  tentativePlacements: PlacementInput[];
  myRack: Tile[];
  myTurn: boolean;
  onClickCell: (cell: BoardCell) => void;
  onDropTile: (tileId: string, cell: BoardCell) => void;
  onStartDraggingTile: (tileId: string | null) => void;
  draggedTileId: string | null;
  onRemoveTile: (placement: PlacementInput) => void;
}) {
  const handleBoardTileDragStart = (event: React.DragEvent, placement: PlacementInput) => {
    if (!myTurn) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/json", JSON.stringify({ type: "remove", placement }));
    onStartDraggingTile(placement.tileId);
  };

  const handleBoardTileDragEnd = () => {
    onStartDraggingTile(null);
  };

  return (
    <div className="mx-auto w-full max-w-[620px] overflow-x-auto rounded-xl bg-gradient-to-br from-slate-100 via-white to-slate-200 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div
        className="grid min-w-[500px] gap-1 rounded-lg bg-slate-700 p-1.5 dark:bg-slate-900 dark:ring-1 dark:ring-white/8"
        style={{ gridTemplateColumns: "repeat(15, minmax(0, 1fr))" }}
      >
        {board.flat().map((cell) => {
          const tentative = tentativePlacements.find((placement) => placement.row === cell.row && placement.col === cell.col);
          const tile = cell.tile
            ? cell.tile
            : tentative
              ? {
                  ...myRack.find((rackTile) => rackTile.id === tentative.tileId),
                  assignedLetter: tentative.letter
                }
              : null;

          return (
            <button
              key={`${cell.row}-${cell.col}`}
              className={`aspect-square min-h-[24px] rounded-md border text-[9px] font-semibold transition ${bonusClasses(cell.bonus)} ${
                tentative ? "ring-2 ring-indigo-500" : ""
              }`}
              onClick={() => onClickCell(cell)}
              onDragOver={(event) => {
                if (myTurn && draggedTileId && !cell.tile) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedTileId) {
                  onDropTile(draggedTileId, cell);
                  onStartDraggingTile(null);
                }
              }}
            >
              {tile ? (
                <span
                  className={`flex h-full flex-col items-center justify-center rounded-md border border-slate-300/50 bg-gradient-to-b from-slate-100 to-slate-200 px-0.5 text-slate-900 shadow-sm dark:border-amber-300/20 dark:bg-gradient-to-b dark:from-amber-100 dark:to-stone-300 dark:text-stone-900 ${
                    tentative && myTurn ? "cursor-grab active:cursor-grabbing hover:brightness-95" : ""
                  }`}
                  draggable={tentative && myTurn}
                  onDragStart={(e) => tentative && handleBoardTileDragStart(e, tentative)}
                  onDragEnd={handleBoardTileDragEnd}
                >
                  <span className="text-[13px] font-bold md:text-sm">{tile.blank ? tile.assignedLetter : tile.letter}</span>
                  <span className="text-[9px] leading-none">{tile.value}</span>
                </span>
              ) : (
                <span className={`flex h-full items-center justify-center text-[8px] uppercase tracking-[0.08em] ${bonusLabelClasses(cell.bonus)}`}>
                  {labelBonus(cell.bonus)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RackTile({
  tile,
  disabled,
  selected,
  exchange,
  onSelect,
  onToggleExchange,
  onDragStart,
  onDragEnd
}: {
  tile: Tile;
  disabled: boolean;
  selected: boolean;
  exchange: boolean;
  onSelect: () => void;
  onToggleExchange: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [dragY, setDragY] = useState<number | null>(null);

  const scale = dragY !== null ? 1 + (dragY / 400) * 0.1 : 1;

  const handleDrag = (event: React.DragEvent) => {
    setDragY(event.clientY);
  };

  return (
    <button
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onDragStart();
        setDragY(0);
      }}
      onDrag={handleDrag}
      onDragEnd={() => {
        onDragEnd();
        setDragY(null);
      }}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onToggleExchange();
      }}
      disabled={disabled}
      className={`min-h-[78px] rounded-lg border px-2 py-2 text-slate-900 dark:text-white shadow-sm transition-all duration-200 ${
        selected ? "border-indigo-500 ring-2 ring-indigo-500" : "border-slate-200 dark:border-slate-700"
      } ${exchange ? "bg-slate-200 dark:bg-slate-700/50" : "bg-slate-100 dark:bg-slate-800/40"} ${
        disabled ? "cursor-not-allowed opacity-50" : "hover:-translate-y-0.5"
      }`}
      style={{
        transform: dragY !== null ? `scale(${Math.min(scale, 1.1)})` : undefined,
        transition: "all 200ms cubic-bezier(0.4, 0, 0.2, 1)"
      }}
    >
      <span className="flex h-full flex-col items-center justify-between">
        <span className="text-[26px] font-bold leading-none">{tile.blank ? "?" : tile.letter}</span>
        <span className="text-xs font-semibold">{tile.value}</span>
      </span>
    </button>
  );
}
