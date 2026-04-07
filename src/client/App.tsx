import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt";
import type {
  AgentConfig,
  AgentTrace,
  BoardCell,
  ChatMessage,
  ClientToServerEvents,
  LegalMove,
  PlacementInput,
  PlayerSeat,
  RoomView,
  ServerToClientEvents,
  Tile
} from "../shared/types";

const CLIENT_ID_KEY = "scrabble-codex-client-id";
const DISPLAY_NAME_KEY = "scrabble-codex-display-name";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type PendingAction = "create" | "join" | "submit_move" | "exchange_tiles" | "pass" | "chat" | "legal_moves" | null;

export function App() {
  const [clientId] = useState(() => getOrCreateClientId());
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(DISPLAY_NAME_KEY) || "Joueur");
  const [roomCode, setRoomCode] = useState("");
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState("");
  const [legalMoves, setLegalMoves] = useState<LegalMove[]>([]);
  const [showLegalMovesPanel, setShowLegalMovesPanel] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [draggedTileId, setDraggedTileId] = useState<string | null>(null);
  const [tentativePlacements, setTentativePlacements] = useState<PlacementInput[]>([]);
  const [exchangeSelection, setExchangeSelection] = useState<string[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [openTraceIds, setOpenTraceIds] = useState<string[]>([]);
  const pendingActionRef = useRef<PendingAction>(null);

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
    socket.auth = {
      clientId,
      displayName
    };
  }, [socket, clientId, displayName]);

  useEffect(() => {
    socket.on("sync", (nextView) => {
      setError("");
      setPendingAction(null);
      pendingActionRef.current = null;
      setView(nextView);
      setRoomCode(nextView.roomId);
      if (!nextView.options.showLegalMoves) {
        setLegalMoves([]);
        setShowLegalMovesPanel(false);
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
    });
    socket.on("legal_moves", (moves) => {
      setPendingAction(null);
      pendingActionRef.current = null;
      setLegalMoves(moves);
      setShowLegalMovesPanel(true);
    });
    socket.on("connect_error", () => {
      setError("Connexion serveur interrompue. Reconnexion en cours.");
      setPendingAction(null);
      pendingActionRef.current = null;
      setTimeout(() => {
        if (!socket.connected) {
          socket.connect();
        }
      }, 500);
    });
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        setError("Le serveur a fermé la session. Reconnexion en cours.");
        socket.connect();
      }
    });

    return () => {
      socket.off("sync");
      socket.off("error_message");
      socket.off("legal_moves");
      socket.off("connect_error");
      socket.off("disconnect");
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    localStorage.setItem(DISPLAY_NAME_KEY, displayName);
  }, [displayName]);

  useEffect(() => {
    setTentativePlacements([]);
    setExchangeSelection([]);
    setSelectedTileId(null);
    setDraggedTileId(null);
  }, [view?.game.lastMove?.id, view?.game.currentPlayerId, view?.game.started]);

  const me = view?.game.players.find((player) => player.id === view.playerId) ?? null;
  const myRack = me?.rack ?? [];
  const myTurn = Boolean(view?.playerId && view.game.currentPlayerId === view.playerId && !view.game.finished);
  const isHost = Boolean(view && view.hostClientId === view.joinedClientId);
  const gameStarted = Boolean(view?.game.started);
  const showLegalMovesFeature = Boolean(view?.options.showLegalMoves);

  function ensureSocketReady(callback?: () => void) {
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

  function emitWhenConnected(callback: () => void) {
    ensureSocketReady(callback);
  }

  function createRoom() {
    setPendingAction("create");
    pendingActionRef.current = "create";
    ensureSocketReady(() => {
      socket.emit("create_room", { displayName });
    });
  }

  function joinRoom() {
    setPendingAction("join");
    pendingActionRef.current = "join";
    ensureSocketReady(() => {
      socket.emit("join_room", { roomId: roomCode.trim(), displayName });
    });
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
    emitWhenConnected(() => {
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
    emitWhenConnected(() => {
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
    emitWhenConnected(() => {
      socket.emit("pass_turn", { roomId: view.roomId });
    });
  }

  function sendChat() {
    if (!view || !chatDraft.trim()) {
      return;
    }
    setPendingAction("chat");
    pendingActionRef.current = "chat";
    emitWhenConnected(() => {
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
    emitWhenConnected(() => {
      socket.emit("get_legal_moves", { roomId: view.roomId });
    });
  }

  function startGame() {
    if (!view) {
      return;
    }
    emitWhenConnected(() => {
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
    ? `À ${view.game.players.find((player) => player.id === view.game.currentPlayerId)?.name ?? "?"}`
    : "En attente";

  return (
    <div className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(234,88,12,0.18),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(8,145,178,0.22),_transparent_32%),linear-gradient(145deg,#faf6ed,#eadfc6_48%,#f8f2e8)] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-none flex-col gap-4 px-3 py-4 md:px-4 md:py-5">
        <header className="rounded-[28px] border border-white/50 bg-white/70 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
          <div className={`grid gap-5 ${gameStarted ? "lg:grid-cols-[1fr_auto]" : "lg:grid-cols-[1.2fr_430px]"}`}>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.35em] text-orange-700">Scrabble Webapp</p>
              <h1 className="font-['Arial_Narrow'] text-5xl font-bold uppercase tracking-[0.08em] text-slate-900 md:text-7xl">
                Scrabble Codex
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                Salons multijoueur, humains et agents IA, chat temps réel, validation serveur autoritaire et assistance
                facultative par coups légaux.
              </p>
            </div>

            {!gameStarted ? (
              <div className="grid gap-3 rounded-3xl border border-slate-200 bg-amber-50/80 p-4">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  Nom
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-cyan-600"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  Code salon
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 uppercase outline-none transition focus:border-cyan-600"
                    value={roomCode}
                    onChange={(event) => setRoomCode(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded-2xl bg-cyan-700 px-4 py-3 font-semibold text-white transition hover:bg-cyan-800"
                    onClick={createRoom}
                  >
                    Créer
                  </button>
                  <button
                    className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-300"
                    onClick={joinRoom}
                  >
                    Rejoindre
                  </button>
                </div>
                {error ? <InlineError message={error} /> : null}
              </div>
            ) : (
              <div className="flex items-start justify-end">
                <div className="rounded-3xl border border-cyan-200 bg-cyan-50/90 px-5 py-4 text-right">
                  <p className="text-xs uppercase tracking-[0.28em] text-cyan-700">Salle</p>
                  <p className="text-3xl font-bold tracking-[0.2em]">{view?.roomId}</p>
                </div>
              </div>
            )}
          </div>
        </header>

        {view ? (
          <main
            className={`grid items-start justify-center gap-4 ${
              gameStarted
                ? "2xl:grid-cols-[minmax(760px,1.45fr)_minmax(520px,1fr)] xl:grid-cols-[minmax(680px,1.35fr)_minmax(440px,1fr)]"
                : "xl:grid-cols-[420px_minmax(0,1fr)]"
            }`}
          >
            {!gameStarted ? (
              <>
                <section className="rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                  <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.28em] text-orange-700">Lobby</p>
                      <h2 className="text-2xl font-semibold">Salon {view.roomId}</h2>
                    </div>
                    {isHost ? (
                      <button
                        className="rounded-2xl bg-cyan-700 px-4 py-3 font-semibold text-white transition hover:bg-cyan-800"
                        onClick={startGame}
                      >
                        Lancer la partie
                      </button>
                    ) : null}
                  </div>

                  <div className="mb-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold">Options de partie</h3>
                        <p className="text-sm text-slate-600">Choisis si les joueurs humains pourront demander les coups légaux.</p>
                      </div>
                    </div>
                    <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        className="h-5 w-5 rounded border-slate-300 text-cyan-700"
                        checked={view.options.showLegalMoves}
                        disabled={!isHost}
                        onChange={(event) => updateRoomOption(event.target.checked)}
                      />
                      Autoriser l’affichage des coups légaux pendant la partie
                    </label>
                  </div>

                  <div className="grid gap-3">
                    {view.game.players.map((seat) => (
                      <SeatEditor key={seat.id} seat={seat} disabled={!isHost || view.game.started} onChange={updateSeat} />
                    ))}
                  </div>
                </section>

                <section className="rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                  <h2 className="mb-4 text-2xl font-semibold">Préparation</h2>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-3xl border border-slate-200 bg-amber-50/80 p-4">
                      <h3 className="mb-2 text-lg font-semibold">Ce qui sera visible en partie</h3>
                      <ul className="space-y-2 text-sm text-slate-700">
                        <li>Code du salon, scores, plateau, chevalet, chat et journal.</li>
                        <li>Les contrôles de création et de join disparaissent pendant la partie.</li>
                        <li>Le panneau de configuration du lobby disparaît aussi après le lancement.</li>
                      </ul>
                    </div>
                    <div className="rounded-3xl border border-slate-200 bg-cyan-50/80 p-4">
                      <h3 className="mb-2 text-lg font-semibold">Aide aux coups légaux</h3>
                      <p className="text-sm leading-6 text-slate-700">
                        Si l’option est activée, les humains peuvent ouvrir ou masquer à volonté un panneau compact des coups
                        légaux. Si elle est désactivée, aucun bouton d’aide n’apparaît en partie.
                      </p>
                    </div>
                  </div>
                  {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
                </section>
              </>
            ) : (
              <>
                <section className="min-w-0 rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                  <div className="mx-auto grid w-full max-w-[1080px] gap-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.28em] text-orange-700">Partie</p>
                        <h2 className="text-2xl font-semibold">Tour {view.game.turn}</h2>
                        <p className="text-sm text-slate-600">
                          Sac {view.game.bagCount} · {boardTitle}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className="rounded-2xl bg-cyan-700 px-4 py-3 font-semibold text-white transition hover:bg-cyan-800 disabled:cursor-not-allowed disabled:bg-cyan-300"
                          onClick={submitMove}
                          disabled={!myTurn || tentativePlacements.length === 0}
                        >
                          Jouer
                        </button>
                        <button
                          className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={clearDraftMove}
                          disabled={tentativePlacements.length === 0}
                        >
                          Effacer
                        </button>
                        <button
                          className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={passTurn}
                          disabled={!myTurn}
                        >
                          Passer
                        </button>
                      </div>
                    </div>

                    {error ? <InlineError message={error} /> : null}

                    <Board
                      board={view.game.board}
                      tentativePlacements={tentativePlacements}
                      myRack={myRack}
                      myTurn={myTurn}
                      onClickCell={onBoardClick}
                      onDropTile={placeTileOnCell}
                      onStartDraggingTile={setDraggedTileId}
                      draggedTileId={draggedTileId}
                    />

                    <div className="rounded-3xl border border-slate-200 bg-amber-50/80 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-lg font-semibold">Chevalet</h3>
                          <p className="text-sm text-slate-600">
                            Clique une tuile puis une case, ou glisse-dépose sur le plateau. Clic droit pour préparer un échange.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {showLegalMovesFeature ? (
                            <button
                              className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={toggleLegalMovesPanel}
                              disabled={!myTurn}
                            >
                              {showLegalMovesPanel ? "Masquer les coups légaux" : "Afficher les coups légaux"}
                            </button>
                          ) : null}
                          <button
                            className="rounded-2xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={exchangeTiles}
                            disabled={!myTurn || exchangeSelection.length === 0}
                          >
                            Échanger {exchangeSelection.length > 0 ? `(${exchangeSelection.length})` : ""}
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
                                setSelectedTileId((current) => (current === tile.id ? null : tile.id));
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
                      <section className="rounded-3xl border border-cyan-200 bg-cyan-50/80 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <h3 className="text-lg font-semibold">Coups légaux</h3>
                            <p className="text-sm text-slate-600">Affichage compact en grille. Clique une carte pour préparer le coup.</p>
                          </div>
                          <button
                            className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={requestLegalMoves}
                            disabled={!myTurn}
                          >
                            Rafraîchir
                          </button>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          {legalMoves.map((move) => (
                            <LegalMoveCard
                              key={`${move.summary}-${move.score}`}
                              move={move}
                              onApply={() => {
                                setTentativePlacements(move.placements);
                                setSelectedTileId(null);
                              }}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                </section>

                <aside className="min-w-0 grid gap-4 xl:grid-cols-2">
                  <section className="rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <h2 className="text-2xl font-semibold">Scores</h2>
                      {view.game.finished ? (
                        <span className="rounded-full bg-orange-100 px-3 py-1 text-sm font-semibold text-orange-700">Terminé</span>
                      ) : null}
                    </div>
                    <div className="grid gap-3">
                      {view.game.players.map((player) => (
                        <div
                          key={player.id}
                          className={`rounded-2xl border px-4 py-3 ${
                            player.isCurrentTurn ? "border-cyan-400 bg-cyan-50" : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-semibold">{player.name}</p>
                              <p className="text-sm text-slate-600">
                                {player.kind === "agent" ? "Agent" : "Humain"} · {player.rackCount} tuiles
                              </p>
                            </div>
                            <p className="text-2xl font-bold">{player.score}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {view.agentTraces.length > 0 ? (
                    <section className="min-w-0 overflow-hidden rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur xl:col-span-2">
                      <h2 className="mb-4 text-2xl font-semibold">Trace agents</h2>
                      <div className="grid gap-3">
                        {view.agentTraces.map((trace) => (
                          <AgentTracePanel
                            key={trace.playerId}
                            trace={trace}
                            open={openTraceIds.includes(trace.playerId)}
                            onToggle={() =>
                              setOpenTraceIds((current) =>
                                current.includes(trace.playerId)
                                  ? current.filter((id) => id !== trace.playerId)
                                  : [...current, trace.playerId]
                              )
                            }
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}

                  <section className="rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                    <h2 className="mb-4 text-2xl font-semibold">Chat</h2>
                    <div className="grid max-h-[320px] gap-3 overflow-auto pr-1">
                      {view.chat.map((message) => (
                        <ChatBubble key={message.id} message={message} />
                      ))}
                    </div>
                    <div className="mt-4 grid gap-3">
                      <input
                        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-cyan-600"
                        value={chatDraft}
                        onChange={(event) => setChatDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            sendChat();
                          }
                        }}
                        placeholder="Écrire un message"
                      />
                      <button
                        className="rounded-2xl bg-cyan-700 px-4 py-3 font-semibold text-white transition hover:bg-cyan-800"
                        onClick={sendChat}
                      >
                        Envoyer
                      </button>
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-white/50 bg-white/75 p-5 shadow-[0_24px_80px_rgba(72,52,12,0.12)] backdrop-blur">
                    <h2 className="mb-4 text-2xl font-semibold">Journal</h2>
                    <div className="grid max-h-[320px] gap-3 overflow-auto pr-1">
                      {view.logs.map((log) => (
                        <div key={log.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                          <p className="font-semibold">{log.playerName}</p>
                          <p className="text-sm text-slate-600">{log.summary}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                </aside>
              </>
            )}
          </main>
        ) : null}
      </div>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      {message}
    </div>
  );
}

function Board({
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
    <div
      className="mx-auto grid w-full max-w-[1080px] gap-1 rounded-[22px] bg-slate-700 p-2"
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
            className={`aspect-square min-h-[24px] rounded-lg border text-[10px] font-semibold transition md:text-xs ${
              bonusClasses(cell.bonus)
            } ${tentative ? "ring-2 ring-cyan-500" : ""}`}
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
                <span className="text-sm font-bold md:text-base">{tile.blank ? tile.assignedLetter : tile.letter}</span>
                <span className="text-[10px]">{tile.value}</span>
              </span>
            ) : (
              <span className="flex h-full items-center justify-center text-[9px] uppercase tracking-wide text-slate-700">
                {labelBonus(cell.bonus)}
              </span>
            )}
          </button>
        );
      })}
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
      className={`min-h-[86px] rounded-[20px] border px-2 py-2 text-slate-900 shadow-sm transition ${
        selected ? "border-cyan-500 ring-2 ring-cyan-500" : "border-amber-300"
      } ${exchange ? "bg-orange-200" : "bg-gradient-to-b from-amber-100 to-amber-300"} ${
        disabled ? "cursor-not-allowed opacity-50" : "hover:-translate-y-0.5"
      }`}
    >
      <span className="flex h-full flex-col items-center justify-between">
        <span className="text-2xl font-bold">{tile.blank ? "?" : tile.letter}</span>
        <span className="text-sm font-semibold">{tile.value}</span>
      </span>
    </button>
  );
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
    <div className={`grid gap-3 rounded-3xl border p-4 ${seat.enabled ? "border-slate-200 bg-slate-50" : "border-slate-200/70 bg-slate-100/60 opacity-60"}`}>
      <div className="flex items-center justify-between gap-3">
        <strong className="text-lg">Siège {seat.seatIndex + 1}</strong>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          Actif
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 text-cyan-700"
            checked={seat.enabled}
            disabled={disabled}
            onChange={(event) => onChange(seat, { enabled: event.target.checked })}
          />
        </label>
      </div>

      <label className="grid gap-2 text-sm font-medium text-slate-700">
        Type
        <select
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
          value={seat.kind}
          disabled={disabled}
          onChange={(event) => onChange(seat, { kind: event.target.value as PlayerSeat["kind"] })}
        >
          <option value="human">Humain</option>
          <option value="agent">Agent</option>
        </select>
      </label>

      <label className="grid gap-2 text-sm font-medium text-slate-700">
        Nom
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

      <p className="text-sm text-slate-600">
        {seat.kind === "human"
          ? seat.ownerClientId
            ? seat.connected
              ? "Humain connecté"
              : "Humain déconnecté"
            : "En attente d’un joueur"
          : "Agent autonome"}
      </p>

      {seat.kind === "agent" ? (
        <>
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            Fournisseur
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

          <label className="grid gap-2 text-sm font-medium text-slate-700">
            Modèle
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

          <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 text-cyan-700"
              checked={Boolean(agentConfig.allowLegalMoves)}
              disabled={disabled}
              onChange={(event) =>
                onChange(seat, {
                  agentConfig: { ...agentConfig, allowLegalMoves: event.target.checked, systemPrompt: agentConfig.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT }
                })
              }
            />
            Autoriser cet agent à demander les coups possibles
          </label>

          <label className="grid gap-2 text-sm font-medium text-slate-700">
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

          <label className="grid gap-2 text-sm font-medium text-slate-700">
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

          <label className="grid gap-2 text-sm font-medium text-slate-700">
            Prompt système
            <textarea
              className="min-h-[100px] rounded-2xl border border-slate-200 bg-white px-4 py-3"
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

function AgentTracePanel({
  trace,
  open,
  onToggle
}: {
  trace: AgentTrace;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-3xl border border-slate-200 bg-slate-50">
      <button className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left" onClick={onToggle}>
        <div>
          <p className="font-semibold">{trace.playerName}</p>
          <p className="text-sm text-slate-600">
            {trace.provider} · {trace.model}
          </p>
        </div>
        <span className="rounded-full bg-cyan-100 px-3 py-1 text-xs font-semibold text-cyan-800">
          {open ? "Masquer" : "Afficher"}
        </span>
      </button>
      {open ? (
        <div className="grid max-h-[62vh] gap-3 overflow-y-auto border-t border-slate-200 px-4 py-4 pr-2">
          <AgentTraceEvents events={trace.events} />
        </div>
      ) : null}
    </div>
  );
}

function AgentTraceEvents({ events }: { events: AgentTrace["events"] }) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(events.at(-1)?.id ?? null);

  useEffect(() => {
    setExpandedEventId(events.at(-1)?.id ?? null);
  }, [events]);

  return (
    <div className="min-w-0 grid gap-3">
      {events.map((event) => {
        const styles = traceEventClasses(event);
        const expanded = expandedEventId === event.id;
        return (
          <div key={event.id} className={`min-w-0 overflow-hidden rounded-2xl border p-3 ${styles.card}`}>
            <button
              className="flex min-w-0 w-full items-start justify-between gap-3 text-left"
              onClick={() => setExpandedEventId((current) => (current === event.id ? null : event.id))}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{event.title}</p>
                <div
                  className={`mt-1 overflow-hidden break-all whitespace-normal text-xs leading-5 ${styles.content}`}
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 3 as number
                  }}
                >
                  {event.content || "(vide)"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${styles.badge}`}>
                  {event.kind}
                </span>
                <span className="text-xs font-semibold text-slate-500">{expanded ? "−" : "+"}</span>
              </div>
            </button>
            {expanded ? (
              <div className="mt-3 max-w-full overflow-x-auto rounded-xl border border-white/60 bg-white/60 p-3">
                <pre className={`min-w-max whitespace-pre text-xs leading-5 ${styles.content}`}>{event.content}</pre>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LegalMoveCard({ move, onApply }: { move: LegalMove; onApply: () => void }) {
  const isHorizontal = new Set(move.placements.map((placement) => placement.row)).size <= 1;
  const orderedPlacements = [...move.placements].sort((left, right) =>
    isHorizontal ? left.col - right.col : left.row - right.row
  );
  const anchor = orderedPlacements[0];

  return (
    <button
      className="grid gap-3 rounded-3xl border border-cyan-200 bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-cyan-400"
      onClick={onApply}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{move.formedWords.join(", ")}</p>
          <p className="text-xs text-slate-500">
            {anchor ? `${anchor.row + 1},${anchor.col + 1}` : ""} · {isHorizontal ? "horizontal" : "vertical"}
          </p>
        </div>
        <span className="rounded-full bg-cyan-100 px-3 py-1 text-sm font-bold text-cyan-800">{move.score}</span>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`flex rounded-2xl bg-slate-100 p-2 ${isHorizontal ? "flex-row gap-1" : "flex-col gap-1"}`}>
          {orderedPlacements.map((placement) => (
            <div
              key={`${placement.row}-${placement.col}`}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-sm font-bold text-slate-700 shadow-sm"
            >
              {placement.letter ?? "?"}
            </div>
          ))}
        </div>
        <div className="grid content-start gap-1 text-[11px] text-slate-500">
          <span>{move.summary}</span>
          <span>{move.placements.length} tuile(s) posée(s)</span>
        </div>
      </div>
    </button>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const palette =
    message.kind === "agent"
      ? "border-cyan-200 bg-cyan-50"
      : message.kind === "system"
        ? "border-orange-200 bg-orange-50"
        : "border-slate-200 bg-slate-50";

  return (
    <div className={`rounded-2xl border px-4 py-3 ${palette}`}>
      <p className="font-semibold">{message.authorName}</p>
      <p className="mt-1 text-sm leading-6 text-slate-700">{message.text}</p>
    </div>
  );
}

function traceEventClasses(event: AgentTrace["events"][number]): { card: string; badge: string; content: string } {
  const lowerContent = event.content.toLowerCase();
  const isError =
    lowerContent.includes("error") ||
    lowerContent.includes("invalide") ||
    lowerContent.includes("introuvable") ||
    lowerContent.includes("impossible") ||
    lowerContent.includes("pas autoris") ||
    lowerContent.includes("echec");
  const isSuccess =
    lowerContent.includes("points") ||
    lowerContent.includes("message envoyé") ||
    lowerContent.includes("passe son tour") ||
    lowerContent.includes("échang") ||
    lowerContent.includes("jouable");

  switch (event.kind) {
    case "tool_call":
      return {
        card: "border-cyan-200 bg-cyan-50",
        badge: "bg-cyan-100 text-cyan-800",
        content: "text-cyan-950"
      };
    case "tool_result":
      if (isError) {
        return {
          card: "border-red-200 bg-red-50",
          badge: "bg-red-100 text-red-700",
          content: "text-red-900"
        };
      }
      if (isSuccess) {
        return {
          card: "border-emerald-200 bg-emerald-50",
          badge: "bg-emerald-100 text-emerald-700",
          content: "text-emerald-950"
        };
      }
      return {
        card: "border-amber-200 bg-amber-50",
        badge: "bg-amber-100 text-amber-700",
        content: "text-amber-950"
      };
    case "reasoning":
      return {
        card: "border-violet-200 bg-violet-50",
        badge: "bg-violet-100 text-violet-700",
        content: "text-violet-950"
      };
    case "provider_reply":
      return {
        card: "border-slate-200 bg-white",
        badge: "bg-slate-100 text-slate-600",
        content: "text-slate-700"
      };
    case "context":
      return {
        card: "border-sky-200 bg-sky-50",
        badge: "bg-sky-100 text-sky-700",
        content: "text-sky-950"
      };
    case "status":
      return {
        card: isError ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-slate-50",
        badge: isError ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-600",
        content: isError ? "text-orange-950" : "text-slate-700"
      };
    default:
      return {
        card: "border-slate-200 bg-white",
        badge: "bg-slate-100 text-slate-600",
        content: "text-slate-700"
      };
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
      return "MD";
    case "tw":
      return "MT";
    case "center":
      return "★";
    default:
      return "";
  }
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
