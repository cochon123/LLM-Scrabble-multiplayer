import { useEffect, useRef } from "react";
import type { AgentConfig, AgentProvider, AuthUserView, BoardCell, ConversationMode, LegalMove, PlacementInput, PlayerSeat, RoomView, Tile } from "../../shared/types";
import type { ConversationItem } from "../lib/types";
import { roomStatusLabel } from "../lib/helpers";
import { ConversationPanel } from "./ConversationPanel";
import { GameView } from "./GameView";
import { LeaderboardCard } from "./shared";
import { LobbyView } from "./LobbyView";

export function RoomPage(props: {
  routeRoomId: string;
  view: RoomView | null;
  loadingRoom: boolean;
  displayName: string;
  setDisplayName: (value: string) => void;
  error: string;
  isHost: boolean;
  defaultApiKeys: AuthUserView["defaultApiKeys"];
  onSaveDefaultApiKey: (provider: AgentProvider, apiKey: string) => void;
  boardTitle: string;
  conversationMode: ConversationMode;
  onCycleMode: () => void;
  onPause: () => void;
  conversationFeed: ConversationItem[];
  expandedConversationId: string | null;
  onToggleConversationItem: (id: string) => void;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  onSendChat: () => void;
  onJoinAsPlayer: () => void;
  activeHumanSeatAvailable: boolean;
  updateSeat: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
  updateRoomOption: (showLegalMoves: boolean) => void;
  startGame: () => void;
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
  const {
    routeRoomId,
    view,
    loadingRoom,
    displayName,
    setDisplayName,
    error,
    isHost,
    defaultApiKeys,
    onSaveDefaultApiKey,
    boardTitle,
    conversationMode,
    onCycleMode,
    onPause,
    conversationFeed,
    expandedConversationId,
    onToggleConversationItem,
    chatDraft,
    setChatDraft,
    onSendChat,
    onJoinAsPlayer,
    activeHumanSeatAvailable,
    updateSeat,
    updateRoomOption,
    startGame,
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
  } = props;

  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = feedRef.current;
    if (!node) {
      return;
    }
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversationFeed]);

  if (loadingRoom && !view) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="rounded-xl bg-white dark:bg-slate-900 px-6 py-5 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">Loading room…</div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
        <div className="grid max-w-xl gap-4 rounded-xl bg-white dark:bg-slate-900 p-8 text-center shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <h1 className="text-3xl font-bold">Room not found</h1>
          <p className="text-slate-600 dark:text-slate-300">The room `{routeRoomId}` does not exist or is no longer available in memory.</p>
          <button className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500" onClick={() => window.location.assign("/")}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col px-3 py-3 md:px-4 ${
        view.status === "lobby" ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"
      }`}
    >
      <header className="mb-3 rounded-xl bg-white dark:bg-slate-900 px-5 py-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Room {view.roomId}</p>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <img src="/scrabble_logo.png" alt="Scrabble Codex" className="h-8 w-8 md:h-10 md:w-10 rounded-lg object-contain" />
            <h1 className="text-2xl md:text-3xl font-black tracking-[0.08em] text-slate-900 dark:text-white">SCRABBLE</h1>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {view.status === "lobby" ? "Public lobby" : boardTitle}
              {view.paused ? " · Paused" : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-lg font-bold text-slate-900 dark:text-white">{displayName}</p>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              {view.viewerRole === "player" ? "Player" : "Spectator"}
            </span>
            {view.status === "lobby" && view.viewerRole === "spectator" && activeHumanSeatAvailable ? (
              <button className="rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500" onClick={onJoinAsPlayer}>
                Join as player
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main
        className={`grid gap-3 ${
          view.status === "lobby"
            ? "items-start"
            : "min-h-0 flex-1 xl:grid-cols-[280px_minmax(0,1fr)_520px]"
        }`}
      >
        {view.status !== "lobby" && (
        <aside className="min-h-0 overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Leaderboard</p>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Scores</h2>
          </div>
          <div className="grid gap-3">
            {view.game.players.map((player) => (
              <LeaderboardCard key={player.id} player={player} />
            ))}
          </div>
          <div className="mt-4 rounded-xl bg-slate-50 dark:bg-slate-950 p-4 text-sm text-slate-600 dark:text-slate-300">
            <p>Spectators: {view.spectatorCount}</p>
            <p className="mt-1">Status: {roomStatusLabel(view.status)}</p>
          </div>
        </aside>
        )}

        <section className="min-h-0 overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          {view.status === "lobby" ? (
            <LobbyView
              view={view}
              error={error}
              isHost={isHost}
          updateSeat={updateSeat}
          defaultApiKeys={defaultApiKeys}
          onSaveDefaultApiKey={onSaveDefaultApiKey}
          updateRoomOption={updateRoomOption}
              startGame={startGame}
            />
          ) : (
            <GameView
              view={view}
              error={error}
              myTurn={myTurn}
              myRack={myRack}
              tentativePlacements={tentativePlacements}
              setTentativePlacements={setTentativePlacements}
              selectedTileId={selectedTileId}
              draggedTileId={draggedTileId}
              setDraggedTileId={setDraggedTileId}
              setSelectedTileId={setSelectedTileId}
              exchangeSelection={exchangeSelection}
              setExchangeSelection={setExchangeSelection}
              onBoardClick={onBoardClick}
              onDropTile={onDropTile}
              onRemoveTile={onRemoveTile}
              submitMove={submitMove}
              clearDraftMove={clearDraftMove}
              passTurn={passTurn}
              exchangeTiles={exchangeTiles}
              showLegalMovesFeature={showLegalMovesFeature}
              showLegalMovesPanel={showLegalMovesPanel}
              toggleLegalMovesPanel={toggleLegalMovesPanel}
              requestLegalMoves={requestLegalMoves}
              legalMoves={legalMoves}
            />
          )}
        </section>

        {view.status !== "lobby" && (
          <ConversationPanel
            view={view}
            mode={conversationMode}
            onCycleMode={onCycleMode}
            onPause={onPause}
            isHost={isHost}
            feedRef={feedRef}
            items={conversationFeed}
            expandedConversationId={expandedConversationId}
            onToggleConversationItem={onToggleConversationItem}
            chatDraft={chatDraft}
            setChatDraft={setChatDraft}
            onSendChat={onSendChat}
          />
        )}
      </main>
    </div>
  );
}
