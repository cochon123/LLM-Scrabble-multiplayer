import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt";
import type {
  AgentConfig,
  AgentProvider,
  AgentTrace,
  AgentTraceChunk,
  AgentTraceDelta,
  AgentTraceEvent,
  BoardCell,
  ChatMessage,
  ClientToServerEvents,
  ConversationMode,
  LegalMove,
  PlacementInput,
  PlayerSeat,
  RoomDirectoryResponse,
  RoomSummary,
  RoomView,
  ServerToClientEvents,
  Tile
} from "../shared/types";

const CLIENT_ID_KEY = "scrabble-codex-client-id";
const DISPLAY_NAME_KEY = "scrabble-codex-display-name";
const CONVERSATION_MODE_KEY = "scrabble-codex-conversation-mode";
const API_BASE_URL = import.meta.env.DEV ? "http://localhost:3001" : "";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type PendingAction =
  | "create"
  | "join"
  | "watch"
  | "submit_move"
  | "exchange_tiles"
  | "pass"
  | "chat"
  | "legal_moves"
  | "pause"
  | null;

type Route = { page: "home" } | { page: "room"; roomId: string };

type ConversationItem =
  | { id: string; createdAt: number; order: number; type: "chat"; message: ChatMessage }
  | { id: string; createdAt: number; order: number; type: "trace"; trace: AgentTrace; event: AgentTraceEvent };

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [clientId] = useState(() => getOrCreateClientId());
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(DISPLAY_NAME_KEY) || "Player");
  const [conversationMode, setConversationMode] = useState<ConversationMode>(
    () => (localStorage.getItem(CONVERSATION_MODE_KEY) as ConversationMode) || "user"
  );
  const [roomCode, setRoomCode] = useState("");
  const [view, setView] = useState<RoomView | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState("");
  const [loadingRoom, setLoadingRoom] = useState(false);
  const [legalMoves, setLegalMoves] = useState<LegalMove[]>([]);
  const [showLegalMovesPanel, setShowLegalMovesPanel] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [draggedTileId, setDraggedTileId] = useState<string | null>(null);
  const [tentativePlacements, setTentativePlacements] = useState<PlacementInput[]>([]);
  const [exchangeSelection, setExchangeSelection] = useState<string[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);
  const pendingActionRef = useRef<PendingAction>(null);
  const lastFeedIdRef = useRef<string | null>(null);
  const expectedRoomIdRef = useRef<string | null>(null);

  const socket = useMemo<ClientSocket>(() => {
    const serverUrl = import.meta.env.DEV ? "http://localhost:3001" : undefined;
    return io(serverUrl, {
      autoConnect: true,
      transports: ["websocket"],
      reconnection: true,
      auth: {
        clientId,
        displayName
      }
    });
  }, [clientId]);

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    socket.auth = {
      clientId,
      displayName
    };
  }, [socket, clientId, displayName]);

  useEffect(() => {
    localStorage.setItem(DISPLAY_NAME_KEY, displayName);
  }, [displayName]);

  useEffect(() => {
    localStorage.setItem(CONVERSATION_MODE_KEY, conversationMode);
  }, [conversationMode]);

  useEffect(() => {
    function acceptSync(nextView: RoomView): boolean {
      if (pendingActionRef.current === "join" || pendingActionRef.current === "watch") {
        return expectedRoomIdRef.current === nextView.roomId;
      }
      if (pendingActionRef.current === "create") {
        return nextView.roomId !== expectedRoomIdRef.current;
      }
      return route.page === "room" && route.roomId === nextView.roomId;
    }

    socket.on("sync", (nextView) => {
      if (!acceptSync(nextView)) {
        return;
      }
      setError("");
      setPendingAction(null);
      pendingActionRef.current = null;
      expectedRoomIdRef.current = nextView.roomId;
      setView(nextView);
      setRoomCode(nextView.roomId);
      setLoadingRoom(false);
      if (!nextView.options.showLegalMoves) {
        setLegalMoves([]);
        setShowLegalMovesPanel(false);
      }
      if (route.page !== "room" || route.roomId !== nextView.roomId) {
        navigateTo(setRoute, `/rooms/${nextView.roomId}`);
      }
    });

    socket.on("error_message", (message) => {
      setError(message);
      if (pendingActionRef.current === "submit_move") {
        setTentativePlacements([]);
        setSelectedTileId(null);
        setDraggedTileId(null);
      }
      if (pendingActionRef.current === "exchange_tiles") {
        setExchangeSelection([]);
      }
      if (pendingActionRef.current === "legal_moves") {
        setShowLegalMovesPanel(false);
      }
      setPendingAction(null);
      pendingActionRef.current = null;
      expectedRoomIdRef.current = null;
    });

    socket.on("legal_moves", (moves) => {
      setPendingAction(null);
      pendingActionRef.current = null;
      expectedRoomIdRef.current = null;
      setLegalMoves(moves);
      setShowLegalMovesPanel(true);
    });

    socket.on("agent_trace_delta", (payload) => {
      setView((current) => mergeTraceDelta(current, payload));
    });

    socket.on("agent_trace_chunk", (payload) => {
      setView((current) => mergeTraceChunk(current, payload));
    });

    socket.on("room_pause_state", (payload) => {
      setView((current) =>
        current && current.roomId === payload.roomId
          ? {
              ...current,
              paused: payload.paused,
              status: current.game.finished ? "finished" : payload.paused ? "paused" : current.game.started ? "live" : "lobby"
            }
          : current
      );
    });

    socket.on("connect_error", () => {
      setError("Connexion serveur interrompue. Reconnexion en cours.");
      setPendingAction(null);
      pendingActionRef.current = null;
      expectedRoomIdRef.current = null;
      setTimeout(() => {
        if (!socket.connected) {
          socket.connect();
        }
      }, 500);
    });

    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        socket.connect();
      }
    });

    return () => {
      socket.off("sync");
      socket.off("error_message");
      socket.off("legal_moves");
      socket.off("agent_trace_delta");
      socket.off("agent_trace_chunk");
      socket.off("room_pause_state");
      socket.off("connect_error");
      socket.off("disconnect");
      socket.disconnect();
    };
  }, [route, socket]);

  useEffect(() => {
    if (route.page !== "home") {
      return;
    }
    expectedRoomIdRef.current = null;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("leave_room");
    });
    let cancelled = false;

    const loadRooms = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/rooms`);
        const payload = (await response.json()) as RoomDirectoryResponse;
        if (!cancelled) {
          setRooms(payload.rooms);
        }
      } catch {
        if (!cancelled) {
          setRooms([]);
        }
      }
    };

    void loadRooms();
    const timer = window.setInterval(() => {
      void loadRooms();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.page]);

  useEffect(() => {
    if (route.page !== "room") {
      setView(null);
      setLoadingRoom(false);
      return;
    }

    let cancelled = false;
    setLoadingRoom(true);
    setError("");
    setView((current) => (current?.roomId === route.roomId ? current : null));

    const loadRoom = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/rooms/${encodeURIComponent(route.roomId)}?clientId=${encodeURIComponent(clientId)}`
        );
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const payload = (await response.json()) as RoomView;
        if (!cancelled && route.page === "room" && route.roomId === payload.roomId) {
          setView(payload);
          setRoomCode(payload.roomId);
          setLoadingRoom(false);
        }
      } catch {
        if (!cancelled) {
          setView(null);
          setLoadingRoom(false);
        }
      }
    };

    void loadRoom();
    setPendingAction("watch");
    pendingActionRef.current = "watch";
    expectedRoomIdRef.current = route.roomId;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("watch_room", { roomId: route.roomId, displayName });
    });

    return () => {
      cancelled = true;
    };
  }, [route, socket, clientId, displayName]);

  useEffect(() => {
    setTentativePlacements([]);
    setExchangeSelection([]);
    setSelectedTileId(null);
    setDraggedTileId(null);
  }, [view?.game.lastMove?.id, view?.game.currentPlayerId, view?.game.started, view?.paused]);

  const me = view?.game.players.find((player) => player.id === view.playerId) ?? null;
  const myRack = me?.rack ?? [];
  const myTurn = Boolean(view?.viewerRole === "player" && view.playerId && view.game.currentPlayerId === view.playerId && !view.game.finished && !view.paused);
  const isHost = Boolean(view && view.hostClientId === view.joinedClientId);
  const activeHumanSeatAvailable = Boolean(
    view?.status === "lobby" && view.game.players.some((seat) => seat.enabled && seat.kind === "human" && !seat.ownerClientId)
  );
  const showLegalMovesFeature = Boolean(view?.options.showLegalMoves);
  const activeTracePlayerId = getActiveTracePlayerId(view?.agentTraces ?? []);
  const conversationFeed = useMemo(
    () => buildConversationFeed(view, conversationMode, activeTracePlayerId),
    [view, conversationMode, activeTracePlayerId]
  );

  useEffect(() => {
    const latestId = conversationFeed.at(-1)?.id ?? null;
    if (!latestId) {
      return;
    }
    if (latestId !== lastFeedIdRef.current) {
      setExpandedConversationId(latestId);
      lastFeedIdRef.current = latestId;
    }
  }, [conversationFeed]);

  function createRoom() {
    setPendingAction("create");
    pendingActionRef.current = "create";
    expectedRoomIdRef.current = view?.roomId ?? null;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("leave_room");
      socket.emit("create_room", { displayName });
    });
  }

  function joinRoom(targetRoomId?: string) {
    const nextRoomId = (targetRoomId ?? roomCode).trim();
    if (!nextRoomId) {
      setError("Enter a room code.");
      return;
    }
    setPendingAction("join");
    pendingActionRef.current = "join";
    expectedRoomIdRef.current = nextRoomId;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("leave_room");
      socket.emit("join_room", { roomId: nextRoomId, displayName });
    });
  }

  function watchRoom(nextRoomId: string) {
    navigateTo(setRoute, `/rooms/${nextRoomId}`);
  }

  function updateSeat(seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) {
    if (!view) {
      return;
    }
    setError("");
    setView((current) =>
      current
        ? {
            ...current,
            game: {
              ...current.game,
              players: current.game.players.map((candidate) =>
                candidate.id === seat.id
                  ? {
                      ...candidate,
                      ...patch,
                      agentConfig: patch.agentConfig ?? candidate.agentConfig
                    }
                  : candidate
              )
            }
          }
        : current
    );
    socket.emit("update_seat", {
      roomId: view.roomId,
      seatId: seat.id,
      patch
    });
  }

  function updateRoomOption(showLegalMoves: boolean) {
    if (!view) {
      return;
    }
    setError("");
    setView((current) =>
      current
        ? {
            ...current,
            options: {
              ...current.options,
              showLegalMoves
            }
          }
        : current
    );
    socket.emit("update_room_options", {
      roomId: view.roomId,
      patch: { showLegalMoves }
    });
  }

  function clearDraftMove() {
    setTentativePlacements([]);
    setSelectedTileId(null);
    setDraggedTileId(null);
  }

  function placeTileOnCell(tileId: string, cell: BoardCell) {
    if (!myTurn || cell.tile) {
      return;
    }
    const tile = myRack.find((candidate) => candidate.id === tileId);
    if (!tile) {
      return;
    }

    const existingPlacement = tentativePlacements.find((placement) => placement.row === cell.row && placement.col === cell.col);
    if (existingPlacement) {
      setTentativePlacements((current) =>
        current.map((placement) =>
          placement.row === cell.row && placement.col === cell.col
            ? {
                row: cell.row,
                col: cell.col,
                tileId,
                letter: tile.blank ? placement.letter : undefined
              }
            : placement
        )
      );
      return;
    }

    let letter = undefined as string | undefined;
    if (tile.blank) {
      const answer = window.prompt("Lettre pour le joker ?", "E")?.trim().toUpperCase();
      if (!answer) {
        return;
      }
      letter = answer[0];
    }

    setTentativePlacements((current) => {
      const next = current.filter((placement) => placement.tileId !== tileId);
      return [...next, { row: cell.row, col: cell.col, tileId, letter }];
    });
    setSelectedTileId(null);
  }

  function onBoardClick(cell: BoardCell) {
    if (!myTurn) {
      return;
    }
    const existingPlacement = tentativePlacements.find((placement) => placement.row === cell.row && placement.col === cell.col);
    if (existingPlacement) {
      setTentativePlacements((current) =>
        current.filter((placement) => !(placement.row === cell.row && placement.col === cell.col))
      );
      return;
    }
    if (selectedTileId) {
      placeTileOnCell(selectedTileId, cell);
    }
  }

  function submitMove() {
    if (!view || tentativePlacements.length === 0) {
      return;
    }
    setPendingAction("submit_move");
    pendingActionRef.current = "submit_move";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("submit_move", {
        roomId: view.roomId,
        placements: tentativePlacements
      });
    });
  }

  function exchangeTiles() {
    if (!view || exchangeSelection.length === 0) {
      return;
    }
    setPendingAction("exchange_tiles");
    pendingActionRef.current = "exchange_tiles";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("exchange_tiles", {
        roomId: view.roomId,
        tileIds: exchangeSelection
      });
    });
  }

  function passTurn() {
    if (!view) {
      return;
    }
    setPendingAction("pass");
    pendingActionRef.current = "pass";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("pass_turn", { roomId: view.roomId });
    });
  }

  function sendChat() {
    if (!view || !chatDraft.trim()) {
      return;
    }
    setPendingAction("chat");
    pendingActionRef.current = "chat";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("send_chat", {
        roomId: view.roomId,
        text: chatDraft
      });
    });
    setChatDraft("");
  }

  function requestLegalMoves() {
    if (!view || !showLegalMovesFeature) {
      return;
    }
    setPendingAction("legal_moves");
    pendingActionRef.current = "legal_moves";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("get_legal_moves", { roomId: view.roomId });
    });
  }

  function togglePause() {
    if (!view) {
      return;
    }
    setPendingAction("pause");
    pendingActionRef.current = "pause";
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("toggle_pause", { roomId: view.roomId });
    });
  }

  function startGame() {
    if (!view) {
      return;
    }
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("start_game", { roomId: view.roomId });
    });
  }

  function toggleLegalMovesPanel() {
    if (!showLegalMovesFeature) {
      return;
    }
    if (showLegalMovesPanel) {
      setShowLegalMovesPanel(false);
      return;
    }
    requestLegalMoves();
  }

  const boardTitle = view?.game.currentPlayerId
    ? `To ${view.game.players.find((player) => player.id === view.game.currentPlayerId)?.name ?? "?"}`
    : "Waiting";

  return (
    <div className="h-screen overflow-hidden bg-slate-50 text-slate-900">
      {route.page === "home" ? (
        <HomePage
          displayName={displayName}
          setDisplayName={setDisplayName}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          rooms={rooms}
          error={error}
          onCreate={createRoom}
          onJoin={() => joinRoom()}
          onJoinRoom={(nextRoomId) => joinRoom(nextRoomId)}
          onWatch={watchRoom}
        />
      ) : (
        <RoomPage
          routeRoomId={route.roomId}
          view={view}
          loadingRoom={loadingRoom}
          displayName={displayName}
          setDisplayName={setDisplayName}
          error={error}
          isHost={isHost}
          boardTitle={boardTitle}
          conversationMode={conversationMode}
          onCycleMode={() => setConversationMode(nextConversationMode(conversationMode))}
          onPause={togglePause}
          conversationFeed={conversationFeed}
          expandedConversationId={expandedConversationId}
          onToggleConversationItem={(id) => setExpandedConversationId((current) => (current === id ? null : id))}
          chatDraft={chatDraft}
          setChatDraft={setChatDraft}
          onSendChat={sendChat}
          onJoinAsPlayer={() => joinRoom(route.roomId)}
          activeHumanSeatAvailable={activeHumanSeatAvailable}
          updateSeat={updateSeat}
          updateRoomOption={updateRoomOption}
          startGame={startGame}
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
          onDropTile={placeTileOnCell}
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
    </div>
  );
}

function HomePage({
  displayName,
  setDisplayName,
  roomCode,
  setRoomCode,
  rooms,
  error,
  onCreate,
  onJoin,
  onJoinRoom,
  onWatch
}: {
  displayName: string;
  setDisplayName: (value: string) => void;
  roomCode: string;
  setRoomCode: (value: string) => void;
  rooms: RoomSummary[];
  error: string;
  onCreate: () => void;
  onJoin: () => void;
  onJoinRoom: (roomId: string) => void;
  onWatch: (roomId: string) => void;
}) {
  return (
    <div className="min-h-screen overflow-y-auto bg-slate-50 px-4 py-6 md:px-6">
      <div className="mx-auto grid max-w-7xl gap-6">
        <section className="rounded-[28px] bg-white p-6 shadow-xl shadow-slate-200/80">
          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Scrabble Webapp</p>
              <h1 className="mt-2 text-5xl font-black tracking-[0.08em] text-slate-900 md:text-7xl">SCRABBLE CODEX</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
                Shareable multiplayer rooms, spectator mode, AI agents, real-time chat, and authoritative server-side
                orchestration.
              </p>
            </div>
            <div className="grid gap-4 rounded-[28px] bg-slate-50 p-5">
              <label className="grid gap-2 text-sm font-semibold text-slate-700">
                Name
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-indigo-500"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-700">
                Room code
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 uppercase outline-none transition focus:border-indigo-500"
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={onCreate}>
                  Create room
                </button>
                <button className="rounded-2xl bg-slate-200 px-5 py-3 font-semibold text-slate-800" onClick={onJoin}>
                  Join as player
                </button>
              </div>
              {error ? <InlineError message={error} /> : null}
            </div>
          </div>
        </section>

        <section className="rounded-[28px] bg-white p-6 shadow-xl shadow-slate-200/80">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Directory</p>
              <h2 className="text-3xl font-bold text-slate-900">Active rooms</h2>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600">{rooms.length} room(s)</span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {rooms.map((room) => (
              <RoomCard
                key={room.roomId}
                room={room}
                onWatch={() => onWatch(room.roomId)}
                onJoin={room.status === "lobby" && room.seatSummaries.some((seat) => seat.enabled && seat.kind === "human" && !seat.occupied) ? () => onJoinRoom(room.roomId) : null}
              />
            ))}
            {rooms.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50 p-6 text-slate-500">
                No active rooms right now.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function RoomPage(props: {
  routeRoomId: string;
  view: RoomView | null;
  loadingRoom: boolean;
  displayName: string;
  setDisplayName: (value: string) => void;
  error: string;
  isHost: boolean;
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
  selectedTileId: string | null;
  draggedTileId: string | null;
  setDraggedTileId: (tileId: string | null) => void;
  setSelectedTileId: (tileId: string | null) => void;
  exchangeSelection: string[];
  setExchangeSelection: React.Dispatch<React.SetStateAction<string[]>>;
  onBoardClick: (cell: BoardCell) => void;
  onDropTile: (tileId: string, cell: BoardCell) => void;
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
    selectedTileId,
    draggedTileId,
    setDraggedTileId,
    setSelectedTileId,
    exchangeSelection,
    setExchangeSelection,
    onBoardClick,
    onDropTile,
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
      <div className="flex h-full items-center justify-center bg-slate-50">
        <div className="rounded-[24px] bg-white px-6 py-5 shadow-xl shadow-slate-200/80">Loading room…</div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 px-4">
        <div className="grid max-w-xl gap-4 rounded-[28px] bg-white p-8 text-center shadow-xl shadow-slate-200/80">
          <h1 className="text-3xl font-bold">Room not found</h1>
          <p className="text-slate-600">The room `{routeRoomId}` does not exist or is no longer available in memory.</p>
          <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={() => window.location.assign("/")}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-3 py-3 md:px-4">
      <header className="mb-3 rounded-[28px] bg-white px-5 py-4 shadow-xl shadow-slate-200/80">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Room {view.roomId}</p>
            <h1 className="mt-1 text-4xl font-black tracking-[0.08em] text-slate-900 md:text-5xl">SCRABBLE CODEX</h1>
            <p className="mt-2 text-sm text-slate-500">
              {view.status === "lobby" ? "Public lobby" : boardTitle}
              {view.paused ? " · Paused" : ""}
            </p>
          </div>
          <div className="grid gap-3 md:min-w-[280px]">
            <label className="grid gap-2 text-sm font-semibold text-slate-700">
              Name
              <input
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-indigo-500"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600">
                {view.viewerRole === "player" ? "Player" : "Spectator"}
              </span>
              {view.status === "lobby" && view.viewerRole === "spectator" && activeHumanSeatAvailable ? (
                <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white" onClick={onJoinAsPlayer}>
                  Join as player
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[280px_minmax(0,0.92fr)_520px]">
        <aside className="min-h-0 overflow-y-auto rounded-[28px] bg-white p-4 shadow-xl shadow-slate-200/80">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Leaderboard</p>
            <h2 className="text-2xl font-bold text-slate-900">Scores</h2>
          </div>
          <div className="grid gap-3">
            {view.game.players.map((player) => (
              <LeaderboardCard key={player.id} player={player} />
            ))}
          </div>
          <div className="mt-4 rounded-[24px] bg-slate-50 p-4 text-sm text-slate-600">
            <p>Spectators: {view.spectatorCount}</p>
            <p className="mt-1">Status: {roomStatusLabel(view.status)}</p>
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto rounded-[28px] bg-white p-4 shadow-xl shadow-slate-200/80">
          {view.status === "lobby" ? (
            <LobbyView
              view={view}
              error={error}
              isHost={isHost}
              updateSeat={updateSeat}
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
              selectedTileId={selectedTileId}
              draggedTileId={draggedTileId}
              setDraggedTileId={setDraggedTileId}
              setSelectedTileId={setSelectedTileId}
              exchangeSelection={exchangeSelection}
              setExchangeSelection={setExchangeSelection}
              onBoardClick={onBoardClick}
              onDropTile={onDropTile}
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
      </main>
    </div>
  );
}

function LobbyView({
  view,
  error,
  isHost,
  updateSeat,
  updateRoomOption,
  startGame
}: {
  view: RoomView;
  error: string;
  isHost: boolean;
  updateSeat: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
  updateRoomOption: (showLegalMoves: boolean) => void;
  startGame: () => void;
}) {
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-indigo-500">Public lobby</p>
          <h2 className="text-3xl font-bold text-slate-900">Configure room</h2>
          <p className="mt-2 text-slate-600">Spectators can watch this room live and send chat messages.</p>
        </div>
        {isHost ? (
          <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={startGame}>
            Start game
          </button>
        ) : null}
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="rounded-[24px] bg-slate-50 p-4">
        <label className="flex items-center gap-3 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 text-indigo-600"
            checked={view.options.showLegalMoves}
            disabled={!isHost}
            onChange={(event) => updateRoomOption(event.target.checked)}
          />
          Allow legal move suggestions for human players
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {view.game.players.map((seat) => (
          <SeatEditor key={seat.id} seat={seat} disabled={!isHost || view.game.started} onChange={updateSeat} />
        ))}
      </div>
    </div>
  );
}

function GameView({
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-indigo-500">Game</p>
          <h2 className="text-3xl font-bold text-slate-900">Turn {view.game.turn}</h2>
          <p className="mt-2 text-slate-600">
            {view.game.players.find((player) => player.id === view.game.currentPlayerId)?.name ?? "Waiting"}
            {view.paused ? " · Paused" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-indigo-300"
            onClick={submitMove}
            disabled={!myTurn || tentativePlacements.length === 0}
          >
            Play
          </button>
          <button
            className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={clearDraftMove}
            disabled={tentativePlacements.length === 0}
          >
            Clear
          </button>
          <button
            className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={passTurn}
            disabled={!myTurn}
          >
            Pass
          </button>
        </div>
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="rounded-[28px] bg-slate-50 p-4">
        <BoardGrid
          board={view.game.board}
          tentativePlacements={tentativePlacements}
          myRack={myRack}
          myTurn={myTurn}
          onClickCell={onBoardClick}
          onDropTile={onDropTile}
          onStartDraggingTile={setDraggedTileId}
          draggedTileId={draggedTileId}
        />
      </div>

      <div className="rounded-[28px] bg-slate-50 p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-bold text-slate-900">Rack</h3>
            <p className="text-sm text-slate-500">Drag and drop tiles to think visually. Right-click to prepare an exchange.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {showLegalMovesFeature ? (
              <button
                className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={toggleLegalMovesPanel}
                disabled={!myTurn}
              >
                {showLegalMovesPanel ? "Hide legal moves" : "Show legal moves"}
              </button>
            ) : null}
            <button
              className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={exchangeTiles}
              disabled={!myTurn || exchangeSelection.length === 0}
            >
              Exchange {exchangeSelection.length > 0 ? `(${exchangeSelection.length})` : ""}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">
          {myRack.map((tile) => {
            const isPlaced = tentativePlacements.some((placement) => placement.tileId === tile.id);
            const inExchange = exchangeSelection.includes(tile.id);
            return (
              <RackTile
                key={tile.id}
                tile={tile}
                disabled={!myTurn || isPlaced}
                selected={selectedTileId === tile.id}
                exchange={inExchange}
                onSelect={() => {
                  if (isPlaced) {
                    return;
                  }
                  setSelectedTileId(selectedTileId === tile.id ? null : tile.id);
                }}
                onToggleExchange={() => {
                  if (!myTurn || isPlaced) {
                    return;
                  }
                  setExchangeSelection((current) =>
                    current.includes(tile.id) ? current.filter((id) => id !== tile.id) : [...current, tile.id]
                  );
                }}
                onDragStart={() => {
                  if (!myTurn || isPlaced) {
                    return;
                  }
                  setDraggedTileId(tile.id);
                }}
                onDragEnd={() => setDraggedTileId(null)}
              />
            );
          })}
        </div>
      </div>

      {showLegalMovesFeature && showLegalMovesPanel ? (
        <section className="rounded-[28px] bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-slate-900">Legal moves</h3>
              <p className="text-sm text-slate-500">Compact grid. Click a card to prepare the move.</p>
            </div>
            <button className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-800" onClick={requestLegalMoves} disabled={!myTurn}>
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

function ConversationPanel({
  view,
  mode,
  onCycleMode,
  onPause,
  isHost,
  feedRef,
  items,
  expandedConversationId,
  onToggleConversationItem,
  chatDraft,
  setChatDraft,
  onSendChat
}: {
  view: RoomView;
  mode: ConversationMode;
  onCycleMode: () => void;
  onPause: () => void;
  isHost: boolean;
  feedRef: React.RefObject<HTMLDivElement | null>;
  items: ConversationItem[];
  expandedConversationId: string | null;
  onToggleConversationItem: (id: string) => void;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  onSendChat: () => void;
}) {
  return (
    <aside className="min-w-0 flex min-h-0 flex-col overflow-hidden rounded-[28px] bg-white p-4 shadow-xl shadow-slate-200/80">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Conversation</p>
          <h2 className="text-2xl font-bold text-slate-900">Agent conversation</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-700" onClick={onCycleMode}>
            Mode: {modeLabel(mode)}
          </button>
          <button
            className="rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-indigo-300"
            onClick={onPause}
            disabled={!isHost || view.status === "lobby" || view.game.finished}
          >
            {view.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div ref={feedRef} className="min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-[24px] bg-slate-50 p-3">
        <div className="grid gap-3">
          {items.map((item) =>
            item.type === "chat" ? (
              <ChatRow key={item.id} message={item.message} />
            ) : (
              <ConversationTraceCard
                key={item.id}
                trace={item.trace}
                event={item.event}
                mode={mode}
                expanded={expandedConversationId === item.id}
                rack={view.game.players.find((player) => player.id === item.trace.playerId)?.rack}
                onToggle={() => onToggleConversationItem(item.id)}
              />
            )
          )}
          {items.length === 0 ? <div className="rounded-[20px] bg-white px-4 py-3 text-sm text-slate-500">No messages yet.</div> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <input
          className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-indigo-500"
          value={chatDraft}
          onChange={(event) => setChatDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSendChat();
            }
          }}
          placeholder="Write a message"
        />
        <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white" onClick={onSendChat}>
          Send
        </button>
      </div>
    </aside>
  );
}

function LeaderboardCard({ player }: { player: PlayerSeat }) {
  return (
    <div
      className={`rounded-[24px] border p-4 ${
        player.isCurrentTurn ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ModelLogo seat={player} size="lg" />
          <div>
            <p className="font-bold text-slate-900">{player.name}</p>
            <p className="text-sm text-slate-500">{player.kind === "agent" ? "Agent" : "Human"}</p>
          </div>
        </div>
        <p className="text-3xl font-black text-slate-900">{player.score}</p>
      </div>
    </div>
  );
}

function RoomCard({ room, onWatch, onJoin }: { room: RoomSummary; onWatch: () => void; onJoin: (() => void) | null }) {
  return (
    <div className="grid gap-4 rounded-[24px] bg-slate-50 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Room</p>
          <h3 className="text-2xl font-bold text-slate-900">{room.roomId}</h3>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${roomStatusBadge(room.status)}`}>{roomStatusLabel(room.status)}</span>
      </div>
      <div className="grid gap-2">
        {room.seatSummaries.filter((seat) => seat.enabled).map((seat) => (
          <div key={seat.id} className="flex items-center justify-between rounded-2xl bg-white px-4 py-3">
            <div className="flex items-center gap-3">
              <ModelLogo seat={seat} size="sm" />
              <div>
                <p className="font-semibold text-slate-900">{seat.name}</p>
                <p className="text-sm text-slate-500">{seat.kind === "agent" ? "Agent" : "Human"}</p>
              </div>
            </div>
            <span className="text-sm font-semibold text-slate-500">{seat.score}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
        <span>{room.spectatorCount} spectator(s)</span>
        <span>{room.currentTurnPlayerName ? `To ${room.currentTurnPlayerName}` : "Waiting"}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white" onClick={onWatch}>
          Watch
        </button>
        {onJoin ? (
          <button className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800" onClick={onJoin}>
            Join
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BoardGrid({
  board,
  tentativePlacements,
  myRack,
  myTurn,
  onClickCell,
  onDropTile,
  onStartDraggingTile,
  draggedTileId
}: {
  board: BoardCell[][];
  tentativePlacements: PlacementInput[];
  myRack: Tile[];
  myTurn: boolean;
  onClickCell: (cell: BoardCell) => void;
  onDropTile: (tileId: string, cell: BoardCell) => void;
  onStartDraggingTile: (tileId: string | null) => void;
  draggedTileId: string | null;
}) {
  return (
    <div className="mx-auto w-full max-w-[600px] overflow-x-auto">
      <div
        className="grid min-w-[500px] gap-1 rounded-[20px] bg-slate-700 p-1.5"
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
                <span className="flex h-full flex-col items-center justify-center rounded-md bg-amber-200 px-0.5 text-slate-900 shadow-inner">
                  <span className="text-[13px] font-bold md:text-sm">{tile.blank ? tile.assignedLetter : tile.letter}</span>
                  <span className="text-[9px] leading-none">{tile.value}</span>
                </span>
              ) : (
                <span className="flex h-full items-center justify-center text-[8px] uppercase tracking-[0.08em] text-slate-700">
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

function RackTile({
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
  return (
    <button
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onToggleExchange();
      }}
      disabled={disabled}
      className={`min-h-[78px] rounded-[18px] border px-2 py-2 text-slate-900 shadow-sm transition ${
        selected ? "border-indigo-500 ring-2 ring-indigo-500" : "border-amber-300"
      } ${exchange ? "bg-orange-200" : "bg-gradient-to-b from-amber-100 to-amber-300"} ${
        disabled ? "cursor-not-allowed opacity-50" : "hover:-translate-y-0.5"
      }`}
    >
      <span className="flex h-full flex-col items-center justify-between">
        <span className="text-[26px] font-bold leading-none">{tile.blank ? "?" : tile.letter}</span>
        <span className="text-xs font-semibold">{tile.value}</span>
      </span>
    </button>
  );
}

function SeatEditor({
  seat,
  disabled,
  onChange
}: {
  seat: PlayerSeat;
  disabled: boolean;
  onChange: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
}) {
  const [draftName, setDraftName] = useState(seat.name);
  const [draftModel, setDraftModel] = useState(seat.agentConfig?.model ?? "local-model");
  const [draftBaseUrl, setDraftBaseUrl] = useState(seat.agentConfig?.baseUrl ?? "");
  const [draftApiKey, setDraftApiKey] = useState(seat.agentConfig?.apiKey ?? "");
  const [draftSystemPrompt, setDraftSystemPrompt] = useState(seat.agentConfig?.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT);
  const agentConfig = seat.agentConfig ?? {
    provider: "openai_compatible",
    model: "local-model",
    baseUrl: defaultBaseUrlForProvider("openai_compatible"),
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    allowLegalMoves: false
  };

  useEffect(() => {
    setDraftName(seat.name);
    setDraftModel(seat.agentConfig?.model ?? "local-model");
    setDraftBaseUrl(seat.agentConfig?.baseUrl ?? "");
    setDraftApiKey(seat.agentConfig?.apiKey ?? "");
    setDraftSystemPrompt(seat.agentConfig?.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT);
  }, [seat.id, seat.name, seat.agentConfig?.provider, seat.agentConfig?.model, seat.agentConfig?.baseUrl, seat.agentConfig?.apiKey, seat.agentConfig?.systemPrompt]);

  return (
    <div className={`grid gap-3 rounded-[24px] border p-4 ${seat.enabled ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-slate-100/70 opacity-60"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ModelLogo seat={seat} size="lg" />
          <div>
            <strong className="block text-lg text-slate-900">Seat {seat.seatIndex + 1}</strong>
            <p className="text-sm text-slate-500">{seat.kind === "agent" ? "AI agent" : "Human player"}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          Active
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 text-indigo-600"
            checked={seat.enabled}
            disabled={disabled}
            onChange={(event) => onChange(seat, { enabled: event.target.checked })}
          />
        </label>
      </div>

      <label className="grid gap-2 text-sm font-semibold text-slate-700">
        Type
        <select
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
          value={seat.kind}
          disabled={disabled}
          onChange={(event) => onChange(seat, { kind: event.target.value as PlayerSeat["kind"] })}
        >
          <option value="human">Human</option>
          <option value="agent">Agent</option>
        </select>
      </label>

      <label className="grid gap-2 text-sm font-semibold text-slate-700">
        Name
        <input
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
          value={draftName}
          disabled={disabled}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => {
            if (draftName !== seat.name) {
              onChange(seat, { name: draftName });
            }
          }}
        />
      </label>

      {seat.kind === "agent" ? (
        <>
          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            Provider
            <select
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              value={agentConfig.provider}
              disabled={disabled}
              onChange={(event) => {
                const nextProvider = event.target.value as AgentConfig["provider"];
                const nextBaseUrl = defaultBaseUrlForProvider(nextProvider);
                setDraftBaseUrl(nextBaseUrl);
                onChange(seat, {
                  agentConfig: {
                    ...agentConfig,
                    provider: nextProvider,
                    baseUrl: nextBaseUrl,
                    systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT
                  }
                });
              }}
            >
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="openrouter">OpenRouter</option>
              <option value="google">Google AI</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            Model
            <input
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              value={draftModel}
              disabled={disabled}
              onChange={(event) => setDraftModel(event.target.value)}
              onBlur={() => {
                if (draftModel !== agentConfig.model) {
                  onChange(seat, { agentConfig: { ...agentConfig, model: draftModel, systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT } });
                }
              }}
            />
          </label>

          <label className="flex items-center gap-3 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 text-indigo-600"
              checked={Boolean(agentConfig.allowLegalMoves)}
              disabled={disabled}
              onChange={(event) =>
                onChange(seat, {
                  agentConfig: { ...agentConfig, allowLegalMoves: event.target.checked, systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT }
                })
              }
            />
            Allow this agent to request legal moves
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            Base URL
            <input
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              value={draftBaseUrl}
              disabled={disabled}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              onBlur={() => {
                if (draftBaseUrl !== (agentConfig.baseUrl ?? "")) {
                  onChange(seat, { agentConfig: { ...agentConfig, baseUrl: draftBaseUrl, systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT } });
                }
              }}
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            API key
            <input
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              value={draftApiKey}
              disabled={disabled}
              onChange={(event) => setDraftApiKey(event.target.value)}
              onBlur={() => {
                if (draftApiKey !== (agentConfig.apiKey ?? "")) {
                  onChange(seat, { agentConfig: { ...agentConfig, apiKey: draftApiKey, systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT } });
                }
              }}
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            System prompt
            <textarea
              className="min-h-[120px] rounded-2xl border border-slate-200 bg-white px-4 py-3"
              value={draftSystemPrompt}
              disabled={disabled}
              onChange={(event) => setDraftSystemPrompt(event.target.value)}
              onBlur={() => {
                if (draftSystemPrompt !== (agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT)) {
                  onChange(seat, { agentConfig: { ...agentConfig, systemPrompt: draftSystemPrompt } });
                }
              }}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

function ConversationTraceCard({
  trace,
  event,
  mode,
  expanded,
  rack,
  onToggle
}: {
  trace: AgentTrace;
  event: AgentTraceEvent;
  mode: ConversationMode;
  expanded: boolean;
  rack?: Tile[];
  onToggle: () => void;
}) {
  const styles = traceEventClasses(event);
  const showRack = Boolean(rack && rack.length > 0 && (event.kind === "reasoning" || event.kind === "provider_reply" || event.kind === "status"));
  const showFallbackStats = mode === "dev" && trace.turnCount > 0;
  return (
    <div className={`min-w-0 overflow-hidden rounded-[22px] border p-3 ${styles.card}`}>
      <button className="flex min-w-0 w-full items-start gap-3 text-left" onClick={onToggle}>
        <ModelLogo trace={trace} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-slate-900">{trace.playerName}</p>
                {showFallbackStats ? (
                  <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                    {`fail: ${trace.fallbackCount}/${trace.turnCount}`}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">{event.title}</p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${styles.badge}`}>
              {event.kind}
            </span>
          </div>
          <div
            className={`overflow-hidden break-words whitespace-pre-wrap text-sm leading-6 ${styles.content}`}
            style={
              expanded
                ? undefined
                : {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 3 as number
                  }
            }
          >
            {event.content || "(vide)"}
          </div>
          {showRack ? (
            <div className="mt-3 rounded-[16px] bg-white/60 p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Rack</p>
              <SmallRack rack={rack ?? []} />
            </div>
          ) : null}
        </div>
      </button>
    </div>
  );
}

function ChatRow({ message }: { message: ChatMessage }) {
  const outgoing = message.kind === "agent";
  return (
    <div className={`flex gap-3 ${outgoing ? "flex-row" : "flex-row-reverse"}`}>
      <ModelLogo name={message.authorName} size="sm" />
      <div
        className={`max-w-[85%] rounded-[22px] px-4 py-3 shadow-sm ${
          outgoing ? "rounded-tl-none bg-indigo-600 text-white" : "rounded-tr-none bg-white text-slate-800"
        }`}
      >
        <p className={`text-xs font-bold ${outgoing ? "text-indigo-100" : "text-slate-400"}`}>{message.authorName}</p>
        <p className="mt-1 text-sm leading-6 whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}

function SmallRack({ rack }: { rack: Tile[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {rack.map((tile) => (
        <div
          key={tile.id}
          className="flex h-9 w-9 flex-col items-center justify-center rounded-lg border border-amber-300 bg-amber-100 text-slate-900 shadow-sm"
        >
          <span className="text-xs font-bold leading-none">{tile.blank ? tile.assignedLetter || "?" : tile.letter}</span>
          <span className="text-[8px] leading-none">{tile.value}</span>
        </div>
      ))}
    </div>
  );
}

function ModelLogo({
  seat,
  trace,
  name,
  size
}: {
  seat?: Pick<PlayerSeat, "name" | "kind" | "agentConfig"> | Pick<RoomSummary["seatSummaries"][number], "name" | "kind">;
  trace?: Pick<AgentTrace, "playerName" | "provider" | "model">;
  name?: string;
  size: "sm" | "lg";
}) {
  const model = "agentConfig" in (seat ?? {}) ? seat?.agentConfig?.model : trace?.model;
  const provider = "agentConfig" in (seat ?? {}) ? seat?.agentConfig?.provider : trace?.provider;
  const resolvedName = seat?.name ?? trace?.playerName ?? name ?? "Agent";
  const src = getModelLogo({ model, provider, name: resolvedName });
  return <img src={src} alt={resolvedName} className={`${size === "lg" ? "h-12 w-12" : "h-10 w-10"} rounded-2xl border border-slate-200 bg-white p-1 object-contain`} />;
}

function LegalMoveCard({ move, onApply }: { move: LegalMove; onApply: () => void }) {
  const isHorizontal = new Set(move.placements.map((placement) => placement.row)).size <= 1;
  const orderedPlacements = [...move.placements].sort((left, right) =>
    isHorizontal ? left.col - right.col : left.row - right.row
  );
  const anchor = orderedPlacements[0];

  return (
    <button
      className="grid gap-3 rounded-[24px] bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
      onClick={onApply}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-slate-900">{move.formedWords.join(", ")}</p>
          <p className="text-xs text-slate-500">
            {anchor ? `row ${anchor.row}, col ${anchor.col}` : ""} · {isHorizontal ? "horizontal" : "vertical"}
          </p>
        </div>
        <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-700">{move.score}</span>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`flex rounded-[18px] bg-slate-100 p-2 ${isHorizontal ? "flex-row gap-1" : "flex-col gap-1"}`}>
          {orderedPlacements.map((placement) => (
            <div
              key={`${placement.row}-${placement.col}`}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-sm font-bold text-slate-700 shadow-sm"
            >
              {placement.letter ?? "?"}
            </div>
          ))}
        </div>
        <div className="grid content-start gap-1 text-[11px] text-slate-500">
          <span>{move.summary}</span>
          <span>{move.placements.length} tile(s)</span>
        </div>
      </div>
    </button>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{message}</div>;
}

function ensureSocketReady(socket: ClientSocket, clientId: string, displayName: string, callback?: () => void) {
  socket.auth = {
    clientId,
    displayName
  };
  if (socket.connected) {
    callback?.();
    return;
  }
  socket.once("connect", () => callback?.());
  if (!socket.active) {
    socket.connect();
  }
}

function parseRoute(pathname: string): Route {
  const match = pathname.match(/^\/rooms\/([^/]+)$/);
  if (match) {
    return { page: "room", roomId: decodeURIComponent(match[1]) };
  }
  return { page: "home" };
}

function navigateTo(setRoute: (route: Route) => void, path: string) {
  window.history.pushState({}, "", path);
  setRoute(parseRoute(path));
}

function getOrCreateClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function defaultBaseUrlForProvider(provider: AgentConfig["provider"]): string {
  switch (provider) {
    case "openrouter":
      return "https://openrouter.ai/api/v1/chat/completions";
    case "ollama":
      return "http://127.0.0.1:11434/api/chat";
    case "google":
      return "";
    case "openai_compatible":
    default:
      return "http://127.0.0.1:1234/v1/chat/completions";
  }
}

function bonusClasses(bonus: BoardCell["bonus"]): string {
  switch (bonus) {
    case "dl":
      return "border-cyan-200 bg-cyan-100";
    case "tl":
      return "border-cyan-300 bg-cyan-300";
    case "dw":
      return "border-orange-200 bg-orange-100";
    case "tw":
      return "border-orange-300 bg-orange-300";
    case "center":
      return "border-orange-300 bg-orange-200";
    default:
      return "border-amber-100 bg-amber-50";
  }
}

function labelBonus(bonus: BoardCell["bonus"]): string {
  switch (bonus) {
    case "dl":
      return "DL";
    case "tl":
      return "TL";
    case "dw":
      return "DW";
    case "tw":
      return "TW";
    case "center":
      return "★";
    default:
      return "";
  }
}

function getModelLogo({ model, provider, name }: { model?: string; provider?: AgentProvider; name?: string }): string {
  const key = `${model ?? ""} ${provider ?? ""} ${name ?? ""}`.toLowerCase();
  if (key.includes("glm")) return "/logos/z-ai-logo.png";
  if (key.includes("gpt") || key.includes("openai")) return "/logos/openai-Logo.png";
  if (key.includes("claude") || key.includes("anthropic")) return "/logos/claude-logo.png";
  if (key.includes("gemini") || key.includes("google")) return "/logos/Gemini-logo.png";
  if (key.includes("deepseek")) return "/logos/deepseek_logo.png";
  if (key.includes("grok") || key.includes("xai")) return "/logos/grok_logo.png";
  if (key.includes("minimax")) return "/logos/MiniMax_logo.png";
  return "/logos/z-ai-logo.png";
}

function getActiveTracePlayerId(traces: AgentTrace[]): string | null {
  return [...traces].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.playerId ?? null;
}

function buildConversationFeed(view: RoomView | null, mode: ConversationMode, activeTracePlayerId: string | null): ConversationItem[] {
  if (!view) {
    return [];
  }

  const chatItems: ConversationItem[] = view.chat.map((message) => ({
    id: `chat:${message.id}`,
    createdAt: message.createdAt,
    order: message.createdAt,
    type: "chat",
    message
  }));

  const traceItems: ConversationItem[] = view.agentTraces.flatMap((trace, traceIndex) =>
    trace.events
      .filter((event) => shouldShowTraceEvent(mode, trace.playerId, activeTracePlayerId, event))
      .map((event, eventIndex) => ({
        id: `trace:${trace.playerId}:${event.id}`,
        createdAt: event.createdAt,
        order: traceIndex * 10000 + eventIndex,
        type: "trace" as const,
        trace,
        event
      }))
  );

  return [...chatItems, ...traceItems].sort((left, right) => left.createdAt - right.createdAt || left.order - right.order);
}

function shouldShowTraceEvent(
  mode: ConversationMode,
  playerId: string,
  activeTracePlayerId: string | null,
  event: AgentTraceEvent
): boolean {
  if (event.kind === "context" || event.kind === "prompt") {
    return false;
  }

  if (mode === "dev") {
    return true;
  }

  if (mode === "advanced") {
    return event.kind === "reasoning" || event.kind === "provider_reply" || event.kind === "status";
  }

  return playerId === activeTracePlayerId && (event.kind === "reasoning" || event.kind === "provider_reply" || event.kind === "status");
}

function mergeTraceDelta(current: RoomView | null, payload: AgentTraceDelta): RoomView | null {
  if (!current) {
    return current;
  }
  const traceIndex = current.agentTraces.findIndex((trace) => trace.playerId === payload.playerId);
  if (traceIndex === -1) {
    return current;
  }
  const nextTraces = current.agentTraces.map((trace, index) =>
    index === traceIndex
      ? {
          ...trace,
          updatedAt: payload.event.createdAt,
          events: [...trace.events.filter((event) => event.id !== payload.event.id), payload.event].sort((left, right) => left.createdAt - right.createdAt)
        }
      : trace
  );
  return {
    ...current,
    agentTraces: nextTraces
  };
}

function mergeTraceChunk(current: RoomView | null, payload: AgentTraceChunk): RoomView | null {
  if (!current) {
    return current;
  }
  const nextTraces = current.agentTraces.map((trace) => {
    if (trace.playerId !== payload.playerId) {
      return trace;
    }
    return {
      ...trace,
      updatedAt: Date.now(),
      events: trace.events.map((event) =>
        event.id === payload.eventId
          ? {
              ...event,
              content: event.content + payload.append
            }
          : event
      )
    };
  });
  return {
    ...current,
    agentTraces: nextTraces
  };
}

function nextConversationMode(mode: ConversationMode): ConversationMode {
  if (mode === "user") return "advanced";
  if (mode === "advanced") return "dev";
  return "user";
}

function modeLabel(mode: ConversationMode): string {
  switch (mode) {
    case "advanced":
      return "Advanced";
    case "dev":
      return "Dev";
    case "user":
    default:
      return "User";
  }
}

function roomStatusLabel(status: RoomSummary["status"] | RoomView["status"]): string {
  switch (status) {
    case "lobby":
      return "Lobby";
    case "paused":
      return "Paused";
    case "finished":
      return "Finished";
    case "live":
    default:
      return "Live";
  }
}

function roomStatusBadge(status: RoomSummary["status"]): string {
  switch (status) {
    case "lobby":
      return "bg-slate-100 text-slate-700";
    case "paused":
      return "bg-amber-100 text-amber-700";
    case "finished":
      return "bg-emerald-100 text-emerald-700";
    case "live":
    default:
      return "bg-indigo-100 text-indigo-700";
  }
}

function traceEventClasses(event: AgentTraceEvent): { card: string; badge: string; content: string } {
  const lowerContent = event.content.toLowerCase();
  const isError =
    lowerContent.includes("error") ||
    lowerContent.includes("invalide") ||
    lowerContent.includes("introuvable") ||
    lowerContent.includes("impossible") ||
    lowerContent.includes("pas autoris") ||
    lowerContent.includes("échec");
  const isSuccess =
    lowerContent.includes("points") ||
    lowerContent.includes("message envoyé") ||
    lowerContent.includes("passe son tour") ||
    lowerContent.includes("échang") ||
    lowerContent.includes("jouable");

  switch (event.kind) {
    case "tool_call":
      return { card: "border-cyan-200 bg-cyan-50", badge: "bg-cyan-100 text-cyan-800", content: "text-cyan-950" };
    case "tool_result":
      if (isError) {
        return { card: "border-red-200 bg-red-50", badge: "bg-red-100 text-red-700", content: "text-red-900" };
      }
      if (isSuccess) {
        return { card: "border-emerald-200 bg-emerald-50", badge: "bg-emerald-100 text-emerald-700", content: "text-emerald-950" };
      }
      return { card: "border-amber-200 bg-amber-50", badge: "bg-amber-100 text-amber-700", content: "text-amber-950" };
    case "reasoning":
      return { card: "border-violet-200 bg-violet-50", badge: "bg-violet-100 text-violet-700", content: "text-violet-950" };
    case "provider_reply":
      return { card: "border-slate-200 bg-white", badge: "bg-slate-100 text-slate-600", content: "text-slate-700" };
    case "status":
      return {
        card: isError ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-slate-50",
        badge: isError ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-600",
        content: isError ? "text-orange-950" : "text-slate-700"
      };
    default:
      return { card: "border-slate-200 bg-white", badge: "bg-slate-100 text-slate-600", content: "text-slate-700" };
  }
}
