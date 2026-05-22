import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AgentConfig,
  AgentProvider,
  AuthUserView,
  BoardCell,
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

import { apiFetch, ensureSocketReady } from "./lib/api";
import {
  buildConversationFeed,
  getActiveTracePlayerId,
  getOrCreateClientId,
  mergeTraceChunk,
  mergeTraceDelta,
  navigateTo,
  nextConversationMode,
  parseRoute,
  sanitizeAgentConfigForClientView
} from "./lib/helpers";
import type { ConversationItem, PendingAction, Route } from "./lib/types";

import { HomePage } from "./components/HomePage";
import { RoomPage } from "./components/RoomPage";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DISPLAY_NAME_KEY = "scrabble-codex-display-name";
const CONVERSATION_MODE_KEY = "scrabble-codex-conversation-mode";

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
