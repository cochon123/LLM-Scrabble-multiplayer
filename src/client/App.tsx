import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { buildDefaultAgentSystemPrompt, isDefaultAgentSystemPrompt } from "../shared/agent_prompt";
import type {
  AgentConfig,
  AgentProvider,
  AgentTrace,
  AgentTraceChunk,
  AgentTraceDelta,
  AgentTraceEvent,
  AuthUserView,
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
  const [authUser, setAuthUser] = useState<AuthUserView | null>(null);
  const [authDraftNickname, setAuthDraftNickname] = useState(() => localStorage.getItem(DISPLAY_NAME_KEY) || "");
  const [authDraftPassword, setAuthDraftPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
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
      autoConnect: Boolean(authUser),
      transports: ["websocket"],
      reconnection: true,
      withCredentials: true,
      auth: {
        clientId,
        displayName
      }
    });
  }, [clientId, authUser, displayName]);

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
    let cancelled = false;
    setAuthLoading(true);
    void apiFetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("unauthorized");
        }
        return (await response.json()) as { user: AuthUserView };
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setAuthUser(payload.user);
        setDisplayName(payload.user.nickname);
        setAuthDraftNickname(payload.user.nickname);
        setAuthError("");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setAuthUser(null);
        setAuthError("");
      })
      .finally(() => {
        if (!cancelled) {
          setAuthLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (!authUser) {
      setRooms([]);
      return;
    }
    expectedRoomIdRef.current = null;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("leave_room");
    });
    let cancelled = false;

    const loadRooms = async () => {
      try {
        const response = await apiFetch("/api/rooms");
        if (!response.ok) {
          throw new Error(String(response.status));
        }
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
  }, [route.page, authUser, socket, clientId, displayName]);

  useEffect(() => {
    if (route.page !== "room") {
      setView(null);
      setLoadingRoom(false);
      return;
    }
    if (!authUser) {
      setView(null);
      setLoadingRoom(false);
      setError("Please sign in.");
      return;
    }

    let cancelled = false;
    setLoadingRoom(true);
    setError("");
    setView((current) => (current?.roomId === route.roomId ? current : null));

    const loadRoom = async () => {
      try {
        const response = await apiFetch(`/api/rooms/${encodeURIComponent(route.roomId)}?clientId=${encodeURIComponent(clientId)}`);
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
  }, [route, socket, clientId, displayName, authUser]);

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
    if (!authUser) {
      setAuthError("Please sign in.");
      return;
    }
    setPendingAction("create");
    pendingActionRef.current = "create";
    expectedRoomIdRef.current = view?.roomId ?? null;
    ensureSocketReady(socket, clientId, displayName, () => {
      socket.emit("leave_room");
      socket.emit("create_room", { displayName });
    });
  }

  function joinRoom(targetRoomId?: string) {
    if (!authUser) {
      setAuthError("Please sign in.");
      return;
    }
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

  async function deleteRoom(roomId: string) {
    if (!authUser?.isAdmin) {
      return;
    }
    if (!window.confirm(`Delete game ${roomId}? This will also stop a live game.`)) {
      return;
    }
    const response = await apiFetch(`/api/games/${encodeURIComponent(roomId)}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: "Could not delete game." }))) as { error?: string };
      setError(payload.error || "Could not delete game.");
      return;
    }
    setRooms((current) => current.filter((room) => room.roomId !== roomId));
    if (route.page === "room" && route.roomId === roomId) {
      navigateTo(setRoute, "/");
      setView(null);
    }
  }

  async function authenticate(mode: "login" | "register") {
    setAuthLoading(true);
    setAuthError("");
    try {
      const response = await apiFetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nickname: authDraftNickname,
          password: authDraftPassword
        })
      });
      const payload = (await response.json()) as { user?: AuthUserView; error?: string };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || `${mode} failed.`);
      }
      setAuthUser(payload.user);
      setDisplayName(payload.user.nickname);
      setAuthDraftNickname(payload.user.nickname);
      setAuthDraftPassword("");
      setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setAuthLoading(false);
    }
  }

  function logout() {
    void apiFetch("/api/auth/logout", {
      method: "POST"
    });
    setAuthUser(null);
    setView(null);
    setRooms([]);
    setRoomCode("");
    setChatDraft("");
    socket.disconnect();
    navigateTo(setRoute, "/");
  }

  async function saveDefaultApiKey(provider: AgentProvider, apiKey: string) {
    if (!authUser) {
      return;
    }
    const response = await apiFetch("/api/auth/default-api-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ provider, apiKey })
    });
    const payload = (await response.json()) as { user?: AuthUserView; error?: string };
    if (!response.ok || !payload.user) {
      throw new Error(payload.error || "Could not save default API key.");
    }
    setAuthUser(payload.user);
  }

  function updateSeat(seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) {
    if (!view) {
      return;
    }
    const sanitizedPatch = patch.agentConfig
      ? {
          ...patch,
          agentConfig: sanitizeAgentConfigForClientView(patch.agentConfig)
        }
      : patch;
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
                      ...sanitizedPatch,
                      agentConfig: sanitizedPatch.agentConfig ?? candidate.agentConfig
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

  function onRemoveTile(placement: PlacementInput) {
    setTentativePlacements((current) =>
      current.filter((p) => !(p.row === placement.row && p.col === placement.col))
    );
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
    <div className={`bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white ${route.page === "home" ? "min-h-screen" : "h-screen overflow-hidden"}`}>
      {!authUser ? (
        <HomePage
          displayName={displayName}
          setDisplayName={setDisplayName}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          rooms={[]}
          error={error}
          authUser={null}
          authDraftNickname={authDraftNickname}
          setAuthDraftNickname={setAuthDraftNickname}
          authDraftPassword={authDraftPassword}
          setAuthDraftPassword={setAuthDraftPassword}
          authLoading={authLoading}
          authError={authError}
          onLogin={() => void authenticate("login")}
          onRegister={() => void authenticate("register")}
          onLogout={logout}
          onCreate={createRoom}
          onJoin={() => joinRoom()}
          onJoinRoom={(nextRoomId) => joinRoom(nextRoomId)}
          onWatch={watchRoom}
          onDelete={deleteRoom}
        />
      ) : route.page === "home" ? (
        <HomePage
          displayName={displayName}
          setDisplayName={setDisplayName}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          rooms={rooms}
          error={error}
          authUser={authUser}
          authDraftNickname={authDraftNickname}
          setAuthDraftNickname={setAuthDraftNickname}
          authDraftPassword={authDraftPassword}
          setAuthDraftPassword={setAuthDraftPassword}
          authLoading={authLoading}
          authError={authError}
          onLogin={() => void authenticate("login")}
          onRegister={() => void authenticate("register")}
          onLogout={logout}
          onCreate={createRoom}
          onJoin={() => joinRoom()}
          onJoinRoom={(nextRoomId) => joinRoom(nextRoomId)}
          onWatch={watchRoom}
          onDelete={deleteRoom}
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
          defaultApiKeys={authUser.defaultApiKeys}
          onSaveDefaultApiKey={(provider, apiKey) => void saveDefaultApiKey(provider, apiKey)}
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
    </div>
  );
}

function HomePage({
  roomCode,
  setRoomCode,
  rooms,
  error,
  authUser,
  authDraftNickname,
  setAuthDraftNickname,
  authDraftPassword,
  setAuthDraftPassword,
  authLoading,
  authError,
  onLogin,
  onRegister,
  onLogout,
  onCreate,
  onJoin,
  onJoinRoom,
  onWatch,
  onDelete
}: {
  displayName: string;
  setDisplayName: (value: string) => void;
  roomCode: string;
  setRoomCode: (value: string) => void;
  rooms: RoomSummary[];
  error: string;
  authUser: AuthUserView | null;
  authDraftNickname: string;
  setAuthDraftNickname: (value: string) => void;
  authDraftPassword: string;
  setAuthDraftPassword: (value: string) => void;
  authLoading: boolean;
  authError: string;
  onLogin: () => void;
  onRegister: () => void;
  onLogout: () => void;
  onCreate: () => void;
  onJoin: () => void;
  onJoinRoom: (roomId: string) => void;
  onWatch: (roomId: string) => void;
  onDelete: (roomId: string) => void;
}) {
  return (
    <div className="min-h-screen overflow-y-auto bg-slate-50 dark:bg-slate-950 px-4 py-6 md:px-6">
      <div className="mx-auto grid max-w-7xl gap-6">
        <section className="rounded-[28px] bg-white dark:bg-slate-900 p-6 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Scrabble Webapp</p>
              <h1 className="mt-2 text-5xl font-black tracking-[0.08em] text-slate-900 dark:text-white md:text-7xl">SCRABBLE CODEX</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600 dark:text-slate-300">
                Shareable multiplayer rooms, spectator mode, AI agents, real-time chat, and authoritative server-side
                orchestration.
              </p>
            </div>
            <div className="grid gap-4 rounded-[28px] bg-slate-50 dark:bg-slate-950 p-5">
              {authUser ? (
                <>
                  <div className="rounded-[24px] bg-white dark:bg-slate-900 p-4">
                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Signed in as</p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xl font-bold text-slate-900 dark:text-white">{authUser.nickname}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{authUser.isAdmin ? "Admin" : "User"}</p>
                      </div>
                      <button className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onLogout}>
                        Sign out
                      </button>
                    </div>
                  </div>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Room code
                    <input
                      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 uppercase outline-none transition focus:border-indigo-500"
                      value={roomCode}
                      onChange={(event) => setRoomCode(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={onCreate}>
                      Create room
                    </button>
                    <button className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-5 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onJoin}>
                      Join as player
                    </button>
                  </div>
                  {error ? <InlineError message={error} /> : null}
                </>
              ) : (
                <>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Nickname
                    <input
                      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 outline-none transition focus:border-indigo-500"
                      value={authDraftNickname}
                      onChange={(event) => setAuthDraftNickname(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Password
                    <input
                      type="password"
                      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 outline-none transition focus:border-indigo-500"
                      value={authDraftPassword}
                      onChange={(event) => setAuthDraftPassword(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white disabled:opacity-50"
                      onClick={onLogin}
                      disabled={authLoading}
                    >
                      Sign in
                    </button>
                    <button
                      className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-5 py-3 font-semibold text-slate-800 dark:text-slate-200 disabled:opacity-50"
                      onClick={onRegister}
                      disabled={authLoading}
                    >
                      Register
                    </button>
                  </div>
                  {authError ? <InlineError message={authError} /> : null}
                </>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-[28px] bg-white dark:bg-slate-900 p-6 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Directory</p>
              <h2 className="text-3xl font-bold text-slate-900 dark:text-white">Active rooms</h2>
            </div>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{rooms.length} room(s)</span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {rooms.map((room) => (
              <RoomCard
                key={room.roomId}
                room={room}
                onWatch={() => onWatch(room.roomId)}
                onJoin={room.status === "lobby" && room.seatSummaries.some((seat) => seat.enabled && seat.kind === "human" && !seat.occupied) ? () => onJoinRoom(room.roomId) : null}
                onDelete={authUser?.isAdmin ? () => onDelete(room.roomId) : null}
              />
            ))}
            {rooms.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 p-6 text-slate-500 dark:text-slate-400">
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
        <div className="rounded-[24px] bg-white dark:bg-slate-900 px-6 py-5 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">Loading room…</div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
        <div className="grid max-w-xl gap-4 rounded-[28px] bg-white dark:bg-slate-900 p-8 text-center shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <h1 className="text-3xl font-bold">Room not found</h1>
          <p className="text-slate-600 dark:text-slate-300">The room `{routeRoomId}` does not exist or is no longer available in memory.</p>
          <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={() => window.location.assign("/")}>
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
      <header className="mb-3 rounded-[28px] bg-white dark:bg-slate-900 px-5 py-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Room {view.roomId}</p>
            <span className="text-slate-300 dark:text-slate-600">·</span>
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
              <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white" onClick={onJoinAsPlayer}>
                Join as player
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main
        className={`grid gap-3 xl:grid-cols-[280px_minmax(0,0.92fr)_520px] ${
          view.status === "lobby" ? "items-start" : "min-h-0 flex-1"
        }`}
      >
        <aside className="min-h-0 overflow-y-auto rounded-[28px] bg-white dark:bg-slate-900 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Leaderboard</p>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Scores</h2>
          </div>
          <div className="grid gap-3">
            {view.game.players.map((player) => (
              <LeaderboardCard key={player.id} player={player} />
            ))}
          </div>
          <div className="mt-4 rounded-[24px] bg-slate-50 dark:bg-slate-950 p-4 text-sm text-slate-600 dark:text-slate-300">
            <p>Spectators: {view.spectatorCount}</p>
            <p className="mt-1">Status: {roomStatusLabel(view.status)}</p>
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto rounded-[28px] bg-white dark:bg-slate-900 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
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
  defaultApiKeys,
  onSaveDefaultApiKey,
  updateRoomOption,
  startGame
}: {
  view: RoomView;
  error: string;
  isHost: boolean;
  updateSeat: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
  defaultApiKeys: AuthUserView["defaultApiKeys"];
  onSaveDefaultApiKey: (provider: AgentProvider, apiKey: string) => void;
  updateRoomOption: (showLegalMoves: boolean) => void;
  startGame: () => void;
}) {
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-indigo-500">Public lobby</p>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-white">Configure room</h2>
          <p className="mt-2 text-slate-600 dark:text-slate-300">Spectators can watch this room live and send chat messages.</p>
        </div>
        {isHost ? (
          <button className="rounded-2xl bg-indigo-600 px-5 py-3 font-semibold text-white" onClick={startGame}>
            Start game
          </button>
        ) : null}
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="rounded-[24px] bg-slate-50 dark:bg-slate-950 p-4">
        <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 dark:border-slate-600 text-indigo-600"
            checked={view.options.showLegalMoves}
            disabled={!isHost}
            onChange={(event) => updateRoomOption(event.target.checked)}
          />
          Allow legal move suggestions for human players
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {view.game.players.map((seat) => (
          <SeatEditor
            key={seat.id}
            seat={seat}
            disabled={!isHost || view.game.started}
            defaultApiKeys={defaultApiKeys}
            onSaveDefaultApiKey={onSaveDefaultApiKey}
            onChange={updateSeat}
          />
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
          className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-indigo-300"
          onClick={submitMove}
          disabled={!myTurn || tentativePlacements.length === 0}
        >
          Play
        </button>
        <button
          className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={clearDraftMove}
          disabled={tentativePlacements.length === 0}
        >
          Clear
        </button>
        <button
          className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={passTurn}
          disabled={!myTurn}
        >
          Pass
        </button>
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="rounded-[28px] bg-slate-50 dark:bg-slate-950 p-4">
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
        className={`rounded-[28px] bg-slate-50 dark:bg-slate-950 p-4 transition-all ${
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
                className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={toggleLegalMovesPanel}
                disabled={!myTurn}
              >
                {showLegalMovesPanel ? "Hide legal moves" : "Show legal moves"}
              </button>
            ) : null}
            <button
              className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
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
        <section className="rounded-[28px] bg-slate-50 dark:bg-slate-950 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Legal moves</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Compact grid. Click a card to prepare the move.</p>
            </div>
            <button className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200" onClick={requestLegalMoves} disabled={!myTurn}>
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
    <aside className="min-w-0 flex min-h-0 flex-col overflow-hidden rounded-[28px] bg-white dark:bg-slate-950 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-950/70 dark:ring-1 dark:ring-white/6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Conversation</p>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Chat</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-2xl bg-slate-100 dark:bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 dark:ring-1 dark:ring-white/8" onClick={onCycleMode}>
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

      <div ref={feedRef} className="min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-[24px] bg-slate-100 dark:bg-slate-900 p-3">
        <div className="grid gap-3">
          {items.map((item) =>
            item.type === "chat" ? (
              <ChatRow
                key={item.id}
                message={item.message}
                seat={view.game.players.find((player) => player.id === item.message.authorId)}
                trace={view.agentTraces.find((trace) => trace.playerId === item.message.authorId)}
              />
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
          {items.length === 0 ? <div className="rounded-[20px] bg-white dark:bg-slate-950 px-4 py-3 text-sm text-slate-500 dark:text-slate-400">No messages yet.</div> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <input
          className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-slate-900 dark:text-white outline-none transition focus:border-indigo-500 dark:placeholder:text-slate-500"
          value={chatDraft}
          onChange={(event) => setChatDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSendChat();
            }
          }}
          placeholder="Write a message"
        />
        <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500 transition" onClick={onSendChat}>
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
        player.isCurrentTurn ? "border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20" : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ModelLogo seat={player} size="lg" />
          <div>
            <p className="font-bold text-slate-900 dark:text-white">{player.name}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{player.kind === "agent" ? "Agent" : "Human"}</p>
          </div>
        </div>
        <p className="text-3xl font-black text-slate-900 dark:text-white">{player.score}</p>
      </div>
    </div>
  );
}

function RoomCard({
  room,
  onWatch,
  onJoin,
  onDelete
}: {
  room: RoomSummary;
  onWatch: () => void;
  onJoin: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  return (
    <div className="grid gap-4 rounded-[24px] bg-slate-50 dark:bg-slate-950 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Room</p>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white">{room.roomId}</h3>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${roomStatusBadge(room.status)}`}>{roomStatusLabel(room.status)}</span>
      </div>
      <div className="grid gap-2">
        {room.seatSummaries.filter((seat) => seat.enabled).map((seat) => (
          <div key={seat.id} className="flex items-center justify-between rounded-2xl bg-white dark:bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-3">
              <ModelLogo seat={seat} size="sm" />
              <div>
                <p className="font-semibold text-slate-900 dark:text-white">{seat.name}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">{seat.kind === "agent" ? "Agent" : "Human"}</p>
              </div>
            </div>
            <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">{seat.score}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
        <span>{room.spectatorCount} spectator(s)</span>
        <span>{room.currentTurnPlayerName ? `To ${room.currentTurnPlayerName}` : "Waiting"}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-2xl bg-indigo-600 px-4 py-3 font-semibold text-white" onClick={onWatch}>
          Watch
        </button>
        {onDelete ? (
          <button className="rounded-2xl bg-red-100 dark:bg-red-900/30 px-4 py-3 font-semibold text-red-700 dark:text-red-400" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        {onJoin ? (
          <button className="rounded-2xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onJoin}>
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
    <div className="mx-auto w-full max-w-[620px] overflow-x-auto rounded-[24px] bg-gradient-to-br from-slate-100 via-white to-slate-200 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div
        className="grid min-w-[500px] gap-1 rounded-[20px] bg-slate-700 p-1.5 dark:bg-slate-900 dark:ring-1 dark:ring-white/8"
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
  const [dragY, setDragY] = useState<number | null>(null);

  // Calculate scale based on Y position during drag
  // Start at 1.0, increase to 1.1 as it moves towards the board
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
      className={`min-h-[78px] rounded-[18px] border px-2 py-2 text-slate-900 dark:text-white shadow-sm transition-all duration-200 ${
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

function SeatEditor({
  seat,
  disabled,
  defaultApiKeys,
  onSaveDefaultApiKey,
  onChange
}: {
  seat: PlayerSeat;
  disabled: boolean;
  defaultApiKeys: AuthUserView["defaultApiKeys"];
  onSaveDefaultApiKey: (provider: AgentProvider, apiKey: string) => void;
  onChange: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
}) {
  const defaultPromptForSeat = buildDefaultAgentSystemPrompt(Boolean(seat.agentConfig?.allowLegalMoves));
  const [draftName, setDraftName] = useState(seat.name);
  const [draftModel, setDraftModel] = useState(seat.agentConfig?.model ?? "local-model");
  const [draftBaseUrl, setDraftBaseUrl] = useState(seat.agentConfig?.baseUrl ?? "");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftApiKeyDirty, setDraftApiKeyDirty] = useState(false);
  const [draftSystemPrompt, setDraftSystemPrompt] = useState(seat.agentConfig?.systemPrompt ?? defaultPromptForSeat);
  const agentConfig = seat.agentConfig ?? {
    provider: "openai_compatible",
    model: "local-model",
    baseUrl: defaultBaseUrlForProvider("openai_compatible"),
    systemPrompt: defaultPromptForSeat,
    allowLegalMoves: false
  };

  useEffect(() => {
    setDraftName(seat.name);
    setDraftModel(seat.agentConfig?.model ?? "local-model");
    setDraftBaseUrl(seat.agentConfig?.baseUrl ?? "");
    setDraftApiKey("");
    setDraftApiKeyDirty(false);
    setDraftSystemPrompt(seat.agentConfig?.systemPrompt ?? defaultPromptForSeat);
  }, [defaultPromptForSeat, seat.id, seat.name, seat.agentConfig?.provider, seat.agentConfig?.model, seat.agentConfig?.baseUrl, seat.agentConfig?.systemPrompt, seat.agentConfig?.useSavedApiKey, seat.agentConfig?.hasCustomApiKey]);

  return (
    <div className={`grid gap-3 rounded-[24px] border p-4 ${seat.enabled ? "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950" : "border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/70 opacity-60"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ModelLogo seat={seat} size="lg" />
          <div>
            <strong className="block text-lg text-slate-900 dark:text-white">Seat {seat.seatIndex + 1}</strong>
            <p className="text-sm text-slate-500 dark:text-slate-400">{seat.kind === "agent" ? "AI agent" : "Human player"}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          Active
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 dark:border-slate-600 text-indigo-600"
            checked={seat.enabled}
            disabled={disabled}
            onChange={(event) => onChange(seat, { enabled: event.target.checked })}
          />
        </label>
      </div>

      <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Type
        <select
          className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
          value={seat.kind}
          disabled={disabled}
          onChange={(event) => onChange(seat, { kind: event.target.value as PlayerSeat["kind"] })}
        >
          <option value="human">Human</option>
          <option value="agent">Agent</option>
        </select>
      </label>

      <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Name
        <input
          className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
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
          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Provider
            <select
              className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={agentConfig.provider}
              disabled={disabled}
              onChange={(event) => {
                const nextProvider = event.target.value as AgentConfig["provider"];
                const nextBaseUrl = defaultBaseUrlForProvider(nextProvider);
                const nextUseSavedApiKey = Boolean(defaultApiKeys[nextProvider]);
                setDraftBaseUrl(nextBaseUrl);
                setDraftApiKey("");
                setDraftApiKeyDirty(false);
                onChange(seat, {
                  agentConfig: {
                    ...agentConfig,
                    provider: nextProvider,
                    baseUrl: nextBaseUrl,
                    apiKey: undefined,
                    useSavedApiKey: nextUseSavedApiKey,
                    hasCustomApiKey: false,
                    systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat
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

          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Model
            <input
              className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={draftModel}
              disabled={disabled}
              onChange={(event) => setDraftModel(event.target.value)}
              onBlur={() => {
                if (draftModel !== agentConfig.model) {
                  onChange(seat, { agentConfig: { ...agentConfig, model: draftModel, systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat } });
                }
              }}
            />
          </label>

          <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 dark:border-slate-600 text-indigo-600"
              checked={Boolean(agentConfig.allowLegalMoves)}
              disabled={disabled}
              onChange={(event) => {
                const nextAllowLegalMoves = event.target.checked;
                const nextDefaultPrompt = buildDefaultAgentSystemPrompt(nextAllowLegalMoves);
                const nextSystemPrompt =
                  isDefaultAgentSystemPrompt(agentConfig.systemPrompt) ? nextDefaultPrompt : agentConfig.systemPrompt ?? nextDefaultPrompt;
                setDraftSystemPrompt(nextSystemPrompt);
                onChange(seat, {
                  agentConfig: { ...agentConfig, allowLegalMoves: nextAllowLegalMoves, systemPrompt: nextSystemPrompt }
                });
              }}
            />
            Allow this agent to request legal moves
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Base URL
            <input
              className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={draftBaseUrl}
              disabled={disabled}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              onBlur={() => {
                if (draftBaseUrl !== (agentConfig.baseUrl ?? "")) {
                  onChange(seat, { agentConfig: { ...agentConfig, baseUrl: draftBaseUrl, systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat } });
                }
              }}
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            API key
            <input
              className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={draftApiKey}
              disabled={disabled}
              placeholder={
                agentConfig.useSavedApiKey
                  ? "Default used"
                  : agentConfig.hasCustomApiKey
                    ? "Custom key saved"
                    : "Enter API key"
              }
              onChange={(event) => {
                setDraftApiKey(event.target.value);
                setDraftApiKeyDirty(true);
              }}
              onBlur={() => {
                if (!draftApiKeyDirty) {
                  return;
                }
                const nextApiKey = draftApiKey.trim();
                const nextUseSavedApiKey = !nextApiKey && Boolean(defaultApiKeys[agentConfig.provider]);
                onChange(seat, {
                  agentConfig: {
                    ...agentConfig,
                    apiKey: nextApiKey || undefined,
                    useSavedApiKey: nextUseSavedApiKey,
                    hasCustomApiKey: Boolean(nextApiKey),
                    systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat
                  }
                });
                if (nextApiKey && window.confirm(`Use this API key as the default for ${agentConfig.provider}?`)) {
                  onSaveDefaultApiKey(agentConfig.provider, nextApiKey);
                }
                setDraftApiKey("");
                setDraftApiKeyDirty(false);
              }}
            />
            {agentConfig.useSavedApiKey ? (
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">The saved default key for this provider will be used on the server.</span>
            ) : null}
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            System prompt
            <textarea
              className="min-h-[120px] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={draftSystemPrompt}
              disabled={disabled}
              onChange={(event) => setDraftSystemPrompt(event.target.value)}
              onBlur={() => {
                if (draftSystemPrompt !== (agentConfig.systemPrompt ?? defaultPromptForSeat)) {
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
    <div className={`min-w-0 overflow-hidden rounded-[22px] p-3 ${styles.card}`}>
      <button className="grid min-w-0 w-full gap-3 text-left" onClick={onToggle}>
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-slate-900 dark:text-white">{trace.playerName}</p>
                {showFallbackStats ? (
                  <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
                    {`fail: ${trace.fallbackCount}/${trace.turnCount}`}
                  </span>
                ) : null}
              </div>
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
            <div className="mt-3 rounded-[16px] bg-white dark:bg-slate-950 p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Rack</p>
              <SmallRack rack={rack ?? []} />
            </div>
          ) : null}
        </div>
        <div className="flex items-end justify-start">
          <ModelLogo trace={trace} size="sm" borderless />
        </div>
      </button>
    </div>
  );
}

function ChatRow({
  message,
  seat,
  trace
}: {
  message: ChatMessage;
  seat?: PlayerSeat;
  trace?: AgentTrace;
}) {
  const outgoing = message.kind === "agent";
  return (
    <div className={`flex gap-3 ${outgoing ? "flex-row" : "flex-row-reverse"}`}>
      <ModelLogo seat={seat} trace={trace} name={message.authorName} size="sm" borderless />
      <div
        className={`max-w-[85%] rounded-[22px] px-4 py-3 shadow-sm ${
          outgoing ? "rounded-tl-none bg-indigo-600 text-white dark:bg-indigo-500" : "rounded-tr-none bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        }`}
      >
        <p className={`text-xs font-bold ${outgoing ? "text-indigo-100" : "text-slate-400 dark:text-slate-500"}`}>{message.authorName}</p>
        <p className="mt-1 text-sm leading-6 whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}

function SmallRack({ rack }: { rack: Tile[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {rack.map((tile) => (
        <div key={tile.id} className="flex h-9 w-9 flex-col items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm">
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
  size,
  borderless = false
}: {
  seat?: Pick<PlayerSeat, "name" | "kind" | "agentConfig"> | Pick<RoomSummary["seatSummaries"][number], "name" | "kind">;
  trace?: Pick<AgentTrace, "playerName" | "provider" | "model">;
  name?: string;
  size: "sm" | "lg";
  borderless?: boolean;
}) {
  const kind = seat?.kind;
  const model = "agentConfig" in (seat ?? {}) ? seat?.agentConfig?.model : trace?.model;
  const provider = "agentConfig" in (seat ?? {}) ? seat?.agentConfig?.provider : trace?.provider;
  const resolvedName = seat?.name ?? trace?.playerName ?? name ?? "Agent";
  const className = `${size === "lg" ? "h-12 w-12" : "h-10 w-10"} rounded-2xl bg-white p-1 object-contain shadow-sm ${borderless ? "" : "border border-slate-200 dark:border-slate-300"}`;
  if (resolvedName.trim().toLowerCase() === "system") {
    return <img src="/logos/system.png" alt="System" className={className} />;
  }
  if (kind === "human") {
    return (
      <div className={`${className} flex items-center justify-center`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-full w-full text-slate-700 dark:text-slate-200">
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path
            d="M6 20c0-3.3137 2.6863-6 6-6s6 2.6863 6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }
  const src = getModelLogo({ model, provider, name: resolvedName });
  return <img src={src} alt={resolvedName} className={className} />;
}

function LegalMoveCard({ move, onApply }: { move: LegalMove; onApply: () => void }) {
  const isHorizontal = new Set(move.placements.map((placement) => placement.row)).size <= 1;
  const orderedPlacements = [...move.placements].sort((left, right) =>
    isHorizontal ? left.col - right.col : left.row - right.row
  );
  const anchor = orderedPlacements[0];

  return (
    <button
      className="grid gap-3 rounded-[24px] bg-white dark:bg-slate-900 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
      onClick={onApply}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-slate-900 dark:text-white">{move.formedWords.join(", ")}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {anchor ? `row ${anchor.row}, col ${anchor.col}` : ""} · {isHorizontal ? "horizontal" : "vertical"}
          </p>
        </div>
        <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/30 px-3 py-1 text-sm font-bold text-indigo-700 dark:text-indigo-400">{move.score}</span>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`flex rounded-[18px] bg-slate-100 dark:bg-slate-800 p-2 ${isHorizontal ? "flex-row gap-1" : "flex-col gap-1"}`}>
          {orderedPlacements.map((placement) => (
            <div
              key={`${placement.row}-${placement.col}`}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-white dark:bg-slate-900 text-sm font-bold text-slate-700 dark:text-slate-200 shadow-sm"
            >
              {placement.letter ?? "?"}
            </div>
          ))}
        </div>
        <div className="grid content-start gap-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span>{move.summary}</span>
          <span>{move.placements.length} tile(s)</span>
        </div>
      </div>
    </button>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-400">{message}</div>;
}

function ensureSocketReady(
  socket: ClientSocket,
  clientId: string,
  displayName: string,
  callback?: () => void
) {
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

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include"
  });
}

function sanitizeAgentConfigForClientView(agentConfig: AgentConfig): AgentConfig {
  return {
    ...agentConfig,
    apiKey: "",
    hasCustomApiKey: Boolean(agentConfig.apiKey?.trim()) || Boolean(agentConfig.hasCustomApiKey)
  };
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
      return "border-cyan-200 dark:border-cyan-700/80 bg-cyan-100 dark:bg-cyan-950";
    case "tl":
      return "border-sky-300 dark:border-sky-700/80 bg-sky-300 dark:bg-sky-900";
    case "dw":
      return "border-rose-200 dark:border-rose-700/80 bg-orange-100 dark:bg-rose-950";
    case "tw":
      return "border-orange-300 dark:border-orange-700/80 bg-orange-300 dark:bg-orange-950";
    case "center":
      return "border-amber-300 dark:border-amber-700/80 bg-orange-200 dark:bg-amber-950";
    default:
      return "border-amber-100 bg-amber-50 dark:border-slate-700 dark:bg-slate-800";
  }
}

function bonusLabelClasses(bonus: BoardCell["bonus"]): string {
  switch (bonus) {
    case "dl":
      return "text-cyan-700 dark:text-cyan-300";
    case "tl":
      return "text-cyan-800 dark:text-sky-300";
    case "dw":
      return "text-orange-700 dark:text-rose-300";
    case "tw":
      return "text-orange-800 dark:text-orange-300";
    case "center":
      return "text-orange-700 dark:text-amber-300";
    default:
      return "text-slate-600 dark:text-slate-300";
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
  if (key.includes("glm")) return "/logos/z_ai_logo.png";
  if (key.includes("qwen")) return "/logos/qwen_logo.png";
  if (key.includes("kimi") || key.includes("moonshot")) return "/logos/kimi_logo.png";
  if (key.includes("nemotron") || key.includes("nvidia")) return "/logos/nvidia_logo.png";
  if (key.includes("llama") || key.includes("meta")) return "/logos/meta_logo.png";
  if (key.includes("mimo") || key.includes("xiaomi")) return "/logos/xiaomi_mimo_logo.png";
  if (key.includes("gpt") || key.includes("openai")) return "/logos/openai_logo.png";
  if (key.includes("claude") || key.includes("anthropic")) return "/logos/claude_logo.png";
  if (key.includes("gemini") || key.includes("google")) return "/logos/gemini_logo.png";
  if (key.includes("deepseek")) return "/logos/deepseek_logo.png";
  if (key.includes("grok") || key.includes("xai")) return "/logos/grok_logo.png";
  if (key.includes("minimax")) return "/logos/minimax_logo.png";
  return "/logos/z_ai_logo.png";
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

  return playerId === activeTracePlayerId && event.kind === "reasoning";
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
      return "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200";
    case "paused":
      return "bg-amber-100 dark:bg-amber-900/30 text-amber-700";
    case "finished":
      return "bg-emerald-100 text-emerald-700";
    case "live":
    default:
      return "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400";
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
      return { card: "bg-cyan-50 dark:bg-cyan-950/55", badge: "bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200", content: "text-cyan-950 dark:text-cyan-100" };
    case "tool_result":
      if (isError) {
        return { card: "bg-red-50 dark:bg-red-950/50", badge: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300", content: "text-red-900 dark:text-red-100" };
      }
      if (isSuccess) {
        return { card: "bg-emerald-50 dark:bg-emerald-950/45", badge: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300", content: "text-emerald-950 dark:text-emerald-100" };
      }
      return { card: "bg-amber-50 dark:bg-amber-950/45", badge: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300", content: "text-amber-950 dark:text-amber-100" };
    case "reasoning":
      return { card: "bg-violet-50 dark:bg-violet-950/45", badge: "bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300", content: "text-violet-950 dark:text-violet-100" };
    case "provider_reply":
      return { card: "bg-white dark:bg-slate-950", badge: "bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300", content: "text-slate-700 dark:text-slate-200" };
    case "status":
      return {
        card: isError ? "bg-orange-50 dark:bg-orange-950/45" : "bg-slate-50 dark:bg-slate-950",
        badge: isError ? "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300" : "bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300",
        content: isError ? "text-orange-950 dark:text-orange-100" : "text-slate-700 dark:text-slate-200"
      };
    default:
      return { card: "bg-white dark:bg-slate-950", badge: "bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300", content: "text-slate-700 dark:text-slate-200" };
  }
}
