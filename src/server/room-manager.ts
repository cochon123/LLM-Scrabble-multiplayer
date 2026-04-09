import { nanoid } from "nanoid";
import type { Server, Socket } from "socket.io";
import { BOARD_SIZE, getBonus } from "../shared/constants.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt.js";
import { Dictionary } from "../shared/dictionary.js";
import { ScrabbleGame } from "../shared/game.js";
import type {
  AgentTrace,
  AgentTraceChunk,
  AgentTraceDelta,
  AgentTraceEvent,
  ChatMessage,
  ClientToServerEvents,
  CreateRoomPayload,
  ExchangeTilesPayload,
  JoinRoomPayload,
  PlayerSeat,
  RoomOptions,
  RoomStatus,
  RoomSummary,
  RoomView,
  SendChatPayload,
  ServerToClientEvents,
  StartGamePayload,
  SubmitMovePayload,
  TogglePausePayload,
  TurnLog,
  UpdateRoomOptionsPayload,
  UpdateSeatPayload,
  ViewerRole,
  WatchRoomPayload
} from "../shared/types.js";
import { appendRoomLog, getRoomLogPath } from "./logger.js";
import { runAgentTurn, warmUpAgentProvider } from "./ai.js";

type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type ConversationMessage = { role: "system" | "user" | "assistant"; content: string };

interface ClientRecord {
  clientId: string;
  displayName: string;
  socketId: string;
  roomId?: string;
}

interface PublicTimelineEntry {
  id: string;
  kind: "chat" | "move" | "status";
  text: string;
  createdAt: number;
}

interface AgentConversationState {
  messages: ConversationMessage[];
  initialized: boolean;
  lastPublicEventIndex: number;
  knownBoard: string[][] | null;
}

interface RoomState {
  id: string;
  hostClientId: string;
  options: RoomOptions;
  seats: PlayerSeat[];
  game?: ScrabbleGame;
  chat: ChatMessage[];
  logs: TurnLog[];
  agentTraces: Record<string, AgentTrace>;
  agentStates: Record<string, AgentConversationState>;
  agentRunning: boolean;
  finishedLogged: boolean;
  paused: boolean;
  pauseRequestedByClientId?: string | null;
  agentAbortController: AbortController | null;
  spectatorClientIds: Set<string>;
  publicTimeline: PublicTimelineEntry[];
  updatedAt: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomState>();
  private readonly clients = new Map<string, ClientRecord>();

  constructor(
    private readonly io: Server<ClientToServerEvents, ServerToClientEvents>,
    private readonly dictionary: Dictionary
  ) {}

  attach(socket: ClientSocket): void {
    const clientId = String(socket.handshake.auth.clientId || nanoid());
    const displayName = String(socket.handshake.auth.displayName || "Player");
    const existingClient = this.clients.get(clientId);
    const client: ClientRecord = {
      clientId,
      displayName,
      socketId: socket.id,
      roomId: existingClient?.roomId
    };
    this.clients.set(clientId, client);

    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      if (room) {
        socket.join(room.id);
        if (this.getRoomPlayerId(room, clientId)) {
          this.markPlayerConnection(room, clientId, true, client.displayName);
        } else {
          room.spectatorClientIds.add(clientId);
        }
        this.touchRoom(room);
        this.syncRoom(room.id);
      } else {
        client.roomId = undefined;
      }
    }

    socket.on("create_room", (payload) => this.handleCreateRoom(socket, clientId, payload));
    socket.on("leave_room", () => this.handleLeaveRoom(socket, clientId));
    socket.on("watch_room", (payload) => this.handleWatchRoom(socket, clientId, payload));
    socket.on("join_room", (payload) => this.handleJoinRoom(socket, clientId, payload));
    socket.on("update_room_options", (payload) => this.handleUpdateRoomOptions(clientId, payload));
    socket.on("update_seat", (payload) => this.handleUpdateSeat(clientId, payload));
    socket.on("start_game", (payload) => this.handleStartGame(clientId, payload));
    socket.on("submit_move", (payload) => this.handleSubmitMove(clientId, payload));
    socket.on("exchange_tiles", (payload) => this.handleExchangeTiles(clientId, payload));
    socket.on("pass_turn", (payload) => this.handlePassTurn(clientId, payload.roomId));
    socket.on("send_chat", (payload) => this.handleSendChat(clientId, payload));
    socket.on("get_legal_moves", (payload) => this.handleGetLegalMoves(clientId, payload.roomId));
    socket.on("toggle_pause", (payload) => this.handleTogglePause(clientId, payload));

    socket.on("disconnect", () => {
      const disconnectedClient = this.clients.get(clientId);
      if (!disconnectedClient) {
        return;
      }
      disconnectedClient.socketId = "";
      if (!disconnectedClient.roomId) {
        return;
      }
      const room = this.rooms.get(disconnectedClient.roomId);
      if (!room) {
        return;
      }
      if (this.getRoomPlayerId(room, clientId)) {
        this.markPlayerConnection(room, clientId, false);
      } else {
        room.spectatorClientIds.delete(clientId);
      }
      this.touchRoom(room);
      this.syncRoom(room.id);
    });
  }

  listRoomSummaries(): RoomSummary[] {
    return [...this.rooms.values()]
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getRoomViewSnapshot(roomId: string, clientId?: string | null): RoomView | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    return this.buildRoomView(room, clientId ?? "");
  }

  private handleLeaveRoom(socket: ClientSocket, clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client?.roomId) {
      return;
    }

    const room = this.rooms.get(client.roomId);
    if (room) {
      room.spectatorClientIds.delete(clientId);
      this.markPlayerConnection(room, clientId, false);
      this.touchRoom(room);
      this.syncRoom(room.id);
      socket.leave(room.id);
    }

    client.roomId = undefined;
  }

  private handleCreateRoom(socket: ClientSocket, clientId: string, payload: CreateRoomPayload): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.displayName = payload.displayName.trim() || "Player";
    client.socketId = socket.id;

    const roomId = nanoid(8);
    const room: RoomState = {
      id: roomId,
      hostClientId: clientId,
      options: {
        showLegalMoves: false
      },
      seats: [
        createSeat(0, {
          enabled: true,
          kind: "human",
          name: client.displayName,
          ownerClientId: clientId,
          connected: true
        }),
        createSeat(1, {
          enabled: true,
          kind: "agent",
          name: "Agent Local",
          connected: true,
          agentConfig: defaultAgentConfig()
        }),
        createSeat(2, { enabled: false, kind: "human", name: "Player 3" }),
        createSeat(3, { enabled: false, kind: "human", name: "Player 4" })
      ],
      chat: [systemChat("Room created. Configure the seats, then start the game.")],
      logs: [],
      agentTraces: {},
      agentStates: {},
      agentRunning: false,
      finishedLogged: false,
      paused: false,
      pauseRequestedByClientId: null,
      agentAbortController: null,
      spectatorClientIds: new Set<string>(),
      publicTimeline: [],
      updatedAt: Date.now()
    };

    this.rooms.set(roomId, room);
    this.moveClientToRoom(socket, client, roomId);
    this.pushPublicTimeline(room, "status", "Room created.");
    this.logRoomEvent(room, "room_created", {
      hostClientId: clientId,
      hostName: client.displayName,
      logPath: getRoomLogPath(room.id),
      seats: summarizeSeats(room.seats),
      options: room.options
    });
    this.syncRoom(roomId);
  }

  private handleWatchRoom(socket: ClientSocket, clientId: string, payload: WatchRoomPayload): void {
    const room = this.rooms.get(payload.roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) {
      socket.emit("error_message", "Room not found.");
      return;
    }

    const nextName = payload.displayName?.trim();
    if (nextName) {
      client.displayName = nextName;
    }
    client.socketId = socket.id;
    this.moveClientToRoom(socket, client, room.id);
    if (this.getRoomPlayerId(room, clientId)) {
      this.markPlayerConnection(room, clientId, true, client.displayName);
    } else {
      room.spectatorClientIds.add(clientId);
    }
    this.touchRoom(room);
    this.syncRoom(room.id);
  }

  private handleJoinRoom(socket: ClientSocket, clientId: string, payload: JoinRoomPayload): void {
    const room = this.rooms.get(payload.roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) {
      socket.emit("error_message", "Room not found.");
      return;
    }

    client.displayName = payload.displayName.trim() || client.displayName;
    client.socketId = socket.id;
    this.moveClientToRoom(socket, client, room.id);

    const existingSeat = room.seats.find((seat) => seat.ownerClientId === clientId);
    if (existingSeat) {
      existingSeat.connected = true;
      existingSeat.name = client.displayName;
    } else {
      const seat = room.seats.find((entry) => entry.enabled && entry.kind === "human" && !entry.ownerClientId);
      if (!seat) {
        socket.emit("error_message", "No human player seat is available in this room.");
        room.spectatorClientIds.add(clientId);
        this.syncRoom(room.id);
        return;
      }
      seat.ownerClientId = clientId;
      seat.connected = true;
      seat.name = client.displayName;
    }

    room.spectatorClientIds.delete(clientId);
    room.chat.push(systemChat(`${client.displayName} a rejoint la partie comme joueur.`));
    this.pushPublicTimeline(room, "status", `${client.displayName} rejoint la partie comme joueur.`);
    this.logRoomEvent(room, "player_joined", {
      clientId,
      displayName: client.displayName,
      seats: summarizeSeats(room.seats)
    });
    this.touchRoom(room);
    this.syncRoom(room.id);
  }

  private handleUpdateRoomOptions(clientId: string, payload: UpdateRoomOptionsPayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room) {
      return;
    }
    if (room.hostClientId !== clientId) {
      this.emitToClient(clientId, "error_message", "Seul l'hôte peut modifier les options.");
      return;
    }
    if (room.game) {
      this.emitToClient(clientId, "error_message", "Cannot change options during a live game.");
      return;
    }

    room.options = { ...room.options, ...payload.patch };
    this.touchRoom(room);
    this.logRoomEvent(room, "room_options_updated", {
      updatedBy: clientId,
      options: room.options
    });
    this.syncRoom(room.id);
  }

  private handleUpdateSeat(clientId: string, payload: UpdateSeatPayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room) {
      return;
    }
    if (room.hostClientId !== clientId) {
      this.emitToClient(clientId, "error_message", "Only the host can configure seats.");
      return;
    }
    if (room.game) {
      this.emitToClient(clientId, "error_message", "Cannot change seats during a live game.");
      return;
    }

    const seat = room.seats.find((entry) => entry.id === payload.seatId);
    if (!seat) {
      return;
    }

    const priorOwnerClientId = seat.ownerClientId ?? null;

    if (typeof payload.patch.enabled === "boolean") {
      seat.enabled = payload.patch.enabled;
      if (!seat.enabled) {
        seat.ownerClientId = null;
        seat.connected = false;
      }
    }

    if (payload.patch.kind) {
      seat.kind = payload.patch.kind;
      if (seat.kind === "agent") {
        seat.ownerClientId = null;
        seat.connected = true;
        seat.agentConfig = payload.patch.agentConfig || seat.agentConfig || defaultAgentConfig();
      } else {
        seat.connected = Boolean(seat.ownerClientId);
      }
    }

    if (payload.patch.name) {
      seat.name = payload.patch.name;
    }

    if (payload.patch.agentConfig) {
      seat.agentConfig = payload.patch.agentConfig;
    }

    if (seat.kind === "human" && !seat.ownerClientId && seat.enabled) {
      const availableClient = [...this.clients.values()].find(
        (entry) => entry.roomId === room.id && !room.seats.some((candidate) => candidate.ownerClientId === entry.clientId)
      );
      if (availableClient) {
        seat.ownerClientId = availableClient.clientId;
        seat.connected = availableClient.socketId !== "";
        seat.name = availableClient.displayName;
        room.spectatorClientIds.delete(availableClient.clientId);
      }
    }

    if (priorOwnerClientId && priorOwnerClientId !== seat.ownerClientId) {
      const displacedClient = this.clients.get(priorOwnerClientId);
      if (displacedClient?.roomId === room.id) {
        room.spectatorClientIds.add(priorOwnerClientId);
      }
    }

    this.touchRoom(room);
    this.logRoomEvent(room, "seat_updated", {
      updatedBy: clientId,
      seatId: seat.id,
      seat: summarizeSeat(seat)
    });
    this.syncRoom(room.id);
  }

  private handleStartGame(clientId: string, payload: StartGamePayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room) {
      return;
    }
    if (room.hostClientId !== clientId) {
      this.emitToClient(clientId, "error_message", "Only the host can start the game.");
      return;
    }

    const activeSeats = room.seats.filter((seat) => seat.enabled);
    if (activeSeats.length < 2) {
      this.emitToClient(clientId, "error_message", "Il faut au moins deux joueurs actifs.");
      return;
    }

    const invalidHumanSeat = activeSeats.find((seat) => seat.kind === "human" && !seat.ownerClientId);
    if (invalidHumanSeat) {
      this.emitToClient(clientId, "error_message", "All active human seats must be occupied.");
      return;
    }

    room.game = new ScrabbleGame(room.id, this.dictionary, activeSeats);
    room.game.start();
    room.chat.push(systemChat("The game is starting."));
    room.finishedLogged = false;
    room.paused = false;
    room.agentAbortController = null;
    room.agentStates = {};
    room.publicTimeline = [];
    this.pushPublicTimeline(room, "status", "The game is starting.");
    this.logRoomEvent(room, "game_started", {
      seats: summarizeSeats(activeSeats),
      firstPlayerId: room.game.getCurrentPlayer()?.id ?? null,
      firstPlayerName: room.game.getCurrentPlayer()?.name ?? null
    });
    for (const seat of activeSeats.filter((entry) => entry.kind === "agent")) {
      void warmUpAgentProvider(seat.agentConfig);
    }
    this.touchRoom(room);
    this.syncRoom(room.id);
    void this.runAgentIfNeeded(room.id);
  }

  private handleSubmitMove(clientId: string, payload: SubmitMovePayload): void {
    const room = this.rooms.get(payload.roomId);
    const playerId = room ? this.getRoomPlayerId(room, clientId) : null;
    if (!room || !room.game || !playerId) {
      return;
    }
    if (this.rejectIfPaused(room, clientId)) {
      return;
    }

    const result = room.game.submitMove(playerId, payload.placements);
    if (!result.ok) {
      this.logRoomEvent(room, "human_move_rejected", {
        playerId,
        placements: payload.placements,
        error: result.error
      });
      this.emitToClient(clientId, "error_message", result.error);
      return;
    }

    room.logs.push(result.move);
    this.pushPublicTimeline(room, "move", `${result.move.playerName}: ${result.move.summary}`);
    this.touchRoom(room);
    this.logRoomEvent(room, "human_move_applied", {
      playerId,
      move: result.move,
      nextPlayerId: room.game.getCurrentPlayer()?.id ?? null
    });
    this.logGameFinishedIfNeeded(room);
    this.syncRoom(room.id);
    void this.runAgentIfNeeded(room.id);
  }

  private handleExchangeTiles(clientId: string, payload: ExchangeTilesPayload): void {
    const room = this.rooms.get(payload.roomId);
    const playerId = room ? this.getRoomPlayerId(room, clientId) : null;
    if (!room || !room.game || !playerId) {
      return;
    }
    if (this.rejectIfPaused(room, clientId)) {
      return;
    }

    const result = room.game.exchangeTiles(playerId, payload.tileIds);
    if (!result.ok) {
      this.logRoomEvent(room, "human_exchange_rejected", {
        playerId,
        tileIds: payload.tileIds,
        error: result.error
      });
      this.emitToClient(clientId, "error_message", result.error);
      return;
    }

    room.logs.push(result.move);
    this.pushPublicTimeline(room, "move", `${result.move.playerName}: ${result.move.summary}`);
    this.touchRoom(room);
    this.logRoomEvent(room, "human_exchange_applied", {
      playerId,
      move: result.move,
      nextPlayerId: room.game.getCurrentPlayer()?.id ?? null
    });
    this.logGameFinishedIfNeeded(room);
    this.syncRoom(room.id);
    void this.runAgentIfNeeded(room.id);
  }

  private handlePassTurn(clientId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    const playerId = room ? this.getRoomPlayerId(room, clientId) : null;
    if (!room || !room.game || !playerId) {
      return;
    }
    if (this.rejectIfPaused(room, clientId)) {
      return;
    }

    const result = room.game.pass(playerId);
    if (!result.ok) {
      this.logRoomEvent(room, "human_pass_rejected", {
        playerId,
        error: result.error
      });
      this.emitToClient(clientId, "error_message", result.error);
      return;
    }

    room.logs.push(result.move);
    this.pushPublicTimeline(room, "move", `${result.move.playerName}: ${result.move.summary}`);
    this.touchRoom(room);
    this.logRoomEvent(room, "human_pass_applied", {
      playerId,
      move: result.move,
      nextPlayerId: room.game.getCurrentPlayer()?.id ?? null
    });
    this.logGameFinishedIfNeeded(room);
    this.syncRoom(room.id);
    void this.runAgentIfNeeded(room.id);
  }

  private handleSendChat(clientId: string, payload: SendChatPayload): void {
    const room = this.rooms.get(payload.roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) {
      return;
    }

    const trimmedText = payload.text.trim();
    if (!trimmedText) {
      return;
    }

    const kind: ChatMessage["kind"] = this.getRoomPlayerId(room, clientId) ? "human" : "spectator";
    room.chat.push({
      id: nanoid(),
      authorId: clientId,
      authorName: client.displayName,
      kind,
      text: trimmedText,
      createdAt: Date.now()
    });
    this.pushPublicTimeline(room, "chat", `${client.displayName}: ${trimmedText}`);
    this.touchRoom(room);
    this.logRoomEvent(room, "human_chat", {
      clientId,
      authorName: client.displayName,
      text: trimmedText,
      kind
    });
    this.syncRoom(room.id);
  }

  private handleGetLegalMoves(clientId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    const playerId = room ? this.getRoomPlayerId(room, clientId) : null;
    const client = this.clients.get(clientId);
    if (!room || !room.game || !playerId || !client?.socketId) {
      return;
    }
    if (room.paused) {
      this.emitToClient(clientId, "error_message", "The game is paused.");
      return;
    }
    if (!room.options.showLegalMoves) {
      this.logRoomEvent(room, "human_legal_moves_rejected", {
        playerId,
        reason: "feature_disabled"
      });
      this.emitToClient(clientId, "error_message", "Legal move suggestions are disabled for this game.");
      return;
    }
    const moves = room.game.listLegalMoves(playerId, 12);
    this.logRoomEvent(room, "human_legal_moves_requested", {
      playerId,
      count: moves.length
    });
    this.io.to(client.socketId).emit("legal_moves", moves);
  }

  private handleTogglePause(clientId: string, payload: TogglePausePayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room?.game || room.hostClientId !== clientId) {
      if (room) {
        this.emitToClient(clientId, "error_message", "Only the host can pause the game.");
      }
      return;
    }
    if (room.game.isFinished()) {
      return;
    }

    room.paused = !room.paused;
    room.pauseRequestedByClientId = clientId;
    this.pushPublicTimeline(room, "status", room.paused ? "Game paused." : "Game resumed.");
    this.touchRoom(room);
    this.logRoomEvent(room, room.paused ? "game_paused" : "game_resumed", {
      requestedBy: clientId
    });
    if (room.paused) {
      room.agentAbortController?.abort("room_paused");
    }
    this.io.to(room.id).emit("room_pause_state", {
      roomId: room.id,
      paused: room.paused
    });
    this.syncRoom(room.id);
    if (!room.paused) {
      void this.runAgentIfNeeded(room.id);
    }
  }

  private async runAgentIfNeeded(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || !room.game || room.agentRunning || room.game.isFinished() || room.paused) {
      return;
    }
    const currentPlayer = room.game.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.kind !== "agent") {
      return;
    }

    room.agentRunning = true;
    room.agentAbortController = new AbortController();
    this.logRoomEvent(room, "agent_turn_started", {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      provider: currentPlayer.agentConfig?.provider ?? null,
      model: currentPlayer.agentConfig?.model ?? null,
      allowLegalMoves: Boolean(currentPlayer.agentConfig?.allowLegalMoves),
      rack: currentPlayer.rack.map((tile) => (tile.blank ? "?" : tile.letter))
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    try {
      const result = await runAgentTurn(currentPlayer.id, currentPlayer.agentConfig, {
        roomId,
        game: room.game,
        signal: room.agentAbortController.signal,
        isPaused: () => room.paused,
        logDiagnostic: (type, payload) => this.logRoomEvent(room, `agent_provider_${type}`, payload),
        getPublicTimeline: () => room.publicTimeline,
        pushChat: (playerId, text) => this.pushAgentChat(room, playerId, text),
        beginTrace: (trace) => this.beginTrace(room, trace),
        pushTraceEvent: (playerId, event) => this.pushTraceEvent(room, playerId, event),
        startTraceEvent: (playerId, event) => this.startTraceEvent(room, playerId, event),
        appendTraceChunk: (payload) => this.appendTraceChunk(room, payload),
        getAgentState: (playerId) =>
          room.agentStates[playerId] ?? {
            messages: [],
            initialized: false,
            lastPublicEventIndex: 0,
            knownBoard: null
          },
        setAgentState: (playerId, state) => {
          room.agentStates[playerId] = {
            messages: state.messages.slice(-240),
            initialized: state.initialized,
            lastPublicEventIndex: state.lastPublicEventIndex,
            knownBoard: state.knownBoard?.map((row) => [...row]) ?? null
          };
        }
      });

      const snapshot = room.game.getSnapshot();
      this.logRoomEvent(room, "agent_turn_completed", {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        done: result.done,
        summary: result.summary,
        aborted: Boolean(result.aborted),
        nextPlayerId: snapshot.currentPlayerId
      });

      if (result.done && snapshot.lastMove) {
        room.logs.push(snapshot.lastMove);
        this.pushPublicTimeline(room, "move", `${snapshot.lastMove.playerName}: ${snapshot.lastMove.summary}`);
        this.logRoomEvent(room, "agent_move_applied", {
          playerId: currentPlayer.id,
          move: snapshot.lastMove,
          nextPlayerId: snapshot.currentPlayerId
        });
      }
      this.logGameFinishedIfNeeded(room);
    } finally {
      room.agentRunning = false;
      room.agentAbortController = null;
      this.touchRoom(room);
      this.syncRoom(roomId);
      if (room.game && !room.game.isFinished() && !room.paused) {
        void this.runAgentIfNeeded(roomId);
      }
    }
  }

  private beginTrace(room: RoomState, trace: AgentTrace): void {
    const existing = room.agentTraces[trace.playerId];
    room.agentTraces[trace.playerId] = existing
      ? {
          ...existing,
          playerName: trace.playerName,
          provider: trace.provider,
          model: trace.model,
          systemPrompt: trace.systemPrompt,
          updatedAt: trace.updatedAt,
          turnCount: (existing.turnCount ?? 0) + (trace.turnCount ?? 0),
          fallbackCount: (existing.fallbackCount ?? 0) + (trace.fallbackCount ?? 0),
          events: trace.events.length > 0 ? [...existing.events, ...trace.events].slice(-320) : existing.events
        }
      : {
          ...trace,
          turnCount: trace.turnCount ?? 0,
          fallbackCount: trace.fallbackCount ?? 0,
          events: trace.events.slice(-320)
        };

    this.logRoomEvent(room, "agent_trace_started", {
      playerId: trace.playerId,
      playerName: trace.playerName,
      provider: trace.provider,
      model: trace.model,
      systemPrompt: trace.systemPrompt
    });

    for (const event of trace.events) {
      this.logRoomEvent(room, "agent_trace_event", {
        playerId: trace.playerId,
        playerName: trace.playerName,
        eventKind: event.kind,
        title: event.title,
        content: event.content
      });
      this.io.to(room.id).emit("agent_trace_delta", {
        playerId: trace.playerId,
        event
      });
    }
    this.syncRoom(room.id);
  }

  private pushTraceEvent(room: RoomState, playerId: string, event: AgentTraceEvent): void {
    const trace = room.agentTraces[playerId];
    if (!trace) {
      return;
    }
    trace.events = [...trace.events, event].slice(-320);
    trace.updatedAt = event.createdAt;
    if (event.kind === "status" && event.title === "Fallback") {
      trace.fallbackCount = (trace.fallbackCount ?? 0) + 1;
    }
    this.logRoomEvent(room, "agent_trace_event", {
      playerId,
      playerName: trace.playerName,
      eventKind: event.kind,
      title: event.title,
      content: event.content
    });
    this.io.to(room.id).emit("agent_trace_delta", {
      playerId,
      event
    });
  }

  private startTraceEvent(room: RoomState, playerId: string, event: AgentTraceEvent): void {
    const trace = room.agentTraces[playerId];
    if (!trace) {
      return;
    }
    trace.events = [...trace.events, event].slice(-320);
    trace.updatedAt = event.createdAt;
    if (event.kind === "status" && event.title === "Fallback") {
      trace.fallbackCount = (trace.fallbackCount ?? 0) + 1;
    }
    this.logRoomEvent(room, "agent_trace_event", {
      playerId,
      playerName: trace.playerName,
      eventKind: event.kind,
      title: event.title,
      content: event.content
    });
    this.io.to(room.id).emit("agent_trace_delta", {
      playerId,
      event
    });
  }

  private appendTraceChunk(room: RoomState, payload: AgentTraceChunk): void {
    const trace = room.agentTraces[payload.playerId];
    if (!trace) {
      return;
    }
    const event = trace.events.find((candidate) => candidate.id === payload.eventId);
    if (!event) {
      return;
    }
    event.content += payload.append;
    trace.updatedAt = Date.now();
    this.io.to(room.id).emit("agent_trace_chunk", payload);
    if (payload.done) {
      this.logRoomEvent(room, "agent_trace_event", {
        playerId: payload.playerId,
        playerName: trace.playerName,
        eventKind: event.kind,
        title: event.title,
        content: event.content
      });
    }
  }

  private pushAgentChat(room: RoomState, playerId: string, text: string): ChatMessage {
    const player = room.game?.getPlayer(playerId);
    const message: ChatMessage = {
      id: nanoid(),
      authorId: playerId,
      authorName: player?.name ?? "Agent",
      kind: "agent",
      text,
      createdAt: Date.now()
    };
    room.chat.push(message);
    this.pushPublicTimeline(room, "chat", `${message.authorName}: ${text}`);
    this.touchRoom(room);
    this.logRoomEvent(room, "agent_chat", {
      playerId,
      authorName: message.authorName,
      text
    });
    this.syncRoom(room.id);
    return message;
  }

  private rejectIfPaused(room: RoomState, clientId: string): boolean {
    if (!room.paused) {
      return false;
    }
    this.emitToClient(clientId, "error_message", "The game is paused.");
    return true;
  }

  private moveClientToRoom(socket: ClientSocket, client: ClientRecord, nextRoomId: string): void {
    if (client.roomId && client.roomId !== nextRoomId) {
      const previousRoom = this.rooms.get(client.roomId);
      if (previousRoom) {
        previousRoom.spectatorClientIds.delete(client.clientId);
        this.markPlayerConnection(previousRoom, client.clientId, false);
        this.touchRoom(previousRoom);
        this.syncRoom(previousRoom.id);
      }
      socket.leave(client.roomId);
    }

    client.roomId = nextRoomId;
    socket.join(nextRoomId);
  }

  private markPlayerConnection(room: RoomState, clientId: string, connected: boolean, displayName?: string): void {
    room.seats.forEach((seat) => {
      if (seat.ownerClientId === clientId) {
        seat.connected = connected;
        if (displayName) {
          seat.name = displayName;
        }
      }
    });
  }

  private pushPublicTimeline(room: RoomState, kind: PublicTimelineEntry["kind"], text: string): void {
    room.publicTimeline.push({
      id: nanoid(),
      kind,
      text,
      createdAt: Date.now()
    });
    room.publicTimeline = room.publicTimeline.slice(-320);
  }

  private logRoomEvent(room: RoomState, type: string, payload: Record<string, unknown>): void {
    const snapshot = room.game?.getSnapshot();
    appendRoomLog(room.id, type, {
      turn: snapshot?.turn ?? null,
      currentPlayerId: snapshot?.currentPlayerId ?? null,
      finished: snapshot?.finished ?? false,
      paused: room.paused,
      ...payload
    });
  }

  private logGameFinishedIfNeeded(room: RoomState): void {
    if (!room.game || !room.game.isFinished() || room.finishedLogged) {
      return;
    }

    room.finishedLogged = true;
    const snapshot = room.game.getSnapshot();
    this.logRoomEvent(room, "game_finished", {
      winners: snapshot.winnerIds,
      scores: snapshot.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score
      }))
    });
  }

  private getRoomPlayerId(room: RoomState, clientId: string): string | null {
    const seat = room.seats.find((entry) => entry.ownerClientId === clientId);
    return seat?.id ?? null;
  }

  private syncRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    for (const client of this.clients.values()) {
      if (client.roomId !== room.id || !client.socketId) {
        continue;
      }
      this.io.to(client.socketId).emit("sync", this.buildRoomView(room, client.clientId));
    }
  }

  private buildRoomSummary(room: RoomState): RoomSummary {
    const snapshot = room.game?.getSnapshot();
    const hostSeat = room.seats.find((seat) => seat.ownerClientId === room.hostClientId);
    const currentPlayerName =
      snapshot?.players.find((player) => player.id === snapshot.currentPlayerId)?.name ??
      room.game?.getCurrentPlayer()?.name ??
      null;

    const seatSummaries = (snapshot?.players ?? room.seats).map((seat) => ({
      id: seat.id,
      seatIndex: seat.seatIndex,
      name: seat.name,
      kind: seat.kind,
      enabled: seat.enabled,
      connected: seat.connected,
      occupied: Boolean(seat.ownerClientId) || seat.kind === "agent",
      score: seat.score,
      isCurrentTurn: seat.isCurrentTurn
    }));

    return {
      roomId: room.id,
      status: getRoomStatus(room),
      started: Boolean(snapshot?.started),
      finished: Boolean(snapshot?.finished),
      paused: room.paused,
      playerCount: seatSummaries.filter((seat) => seat.enabled).length,
      spectatorCount: room.spectatorClientIds.size,
      hostName: hostSeat?.name ?? this.clients.get(room.hostClientId)?.displayName ?? "Hôte",
      seatSummaries,
      currentTurnPlayerName: currentPlayerName,
      updatedAt: room.updatedAt
    };
  }

  private buildRoomView(room: RoomState, clientId: string): RoomView {
    const playerId = this.getRoomPlayerId(room, clientId);
    const viewerRole: ViewerRole = playerId ? "player" : "spectator";
    const game = room.game
      ? room.game.getSnapshot(playerId)
      : {
          id: room.id,
          board: Array.from({ length: BOARD_SIZE }, (_, row) =>
            Array.from({ length: BOARD_SIZE }, (_, col) => ({
              row,
              col,
              bonus: getBonus(row, col),
              tile: null
            }))
          ),
          players: room.seats.map((seat) => ({
            ...seat,
            score: 0,
            rackCount: 0,
            rack: playerId === seat.id ? [] : undefined,
            isCurrentTurn: false
          })),
          currentPlayerId: null,
          turn: 1,
          bagCount: 0,
          scorelessTurns: 0,
          started: false,
          finished: false,
          winnerIds: []
        };

    return {
      roomId: room.id,
      hostClientId: room.hostClientId,
      joinedClientId: clientId,
      playerId,
      viewerRole,
      paused: room.paused,
      status: getRoomStatus(room),
      spectatorCount: room.spectatorClientIds.size,
      options: room.options,
      game,
      chat: room.chat.slice(-120),
      logs: room.logs.slice(-120),
      agentTraces: Object.values(room.agentTraces).sort(
        (left, right) =>
          room.seats.findIndex((seat) => seat.id === left.playerId) - room.seats.findIndex((seat) => seat.id === right.playerId)
      )
    };
  }

  private emitToClient<K extends keyof ServerToClientEvents>(
    clientId: string,
    event: K,
    payload: Parameters<ServerToClientEvents[K]>[0]
  ): void {
    const client = this.clients.get(clientId);
    if (!client?.socketId) {
      return;
    }

    if (event === "sync") {
      this.io.to(client.socketId).emit("sync", payload as RoomView);
      return;
    }
    if (event === "error_message") {
      this.io.to(client.socketId).emit("error_message", payload as string);
      return;
    }
    if (event === "legal_moves") {
      this.io.to(client.socketId).emit("legal_moves", payload as never);
      return;
    }
    if (event === "agent_trace_delta") {
      this.io.to(client.socketId).emit("agent_trace_delta", payload as AgentTraceDelta);
      return;
    }
    if (event === "agent_trace_chunk") {
      this.io.to(client.socketId).emit("agent_trace_chunk", payload as AgentTraceChunk);
      return;
    }
    this.io.to(client.socketId).emit("room_pause_state", payload as never);
  }

  private touchRoom(room: RoomState): void {
    room.updatedAt = Date.now();
  }
}

function getRoomStatus(room: RoomState): RoomStatus {
  if (!room.game) {
    return "lobby";
  }
  if (room.game.isFinished()) {
    return "finished";
  }
  if (room.paused) {
    return "paused";
  }
  return "live";
}

function createSeat(
  seatIndex: number,
  overrides: Partial<PlayerSeat> & Pick<PlayerSeat, "enabled" | "kind" | "name">
): PlayerSeat {
  return {
    id: nanoid(),
    seatIndex,
    enabled: overrides.enabled,
    kind: overrides.kind,
    name: overrides.name,
    ownerClientId: overrides.ownerClientId ?? null,
    connected: overrides.connected ?? false,
    score: 0,
    rackCount: 0,
    rack: undefined,
    isCurrentTurn: false,
    agentConfig: overrides.agentConfig
  };
}

function systemChat(text: string): ChatMessage {
  return {
    id: nanoid(),
    authorId: "system",
    authorName: "System",
    kind: "system",
    text,
    createdAt: Date.now()
  };
}

function defaultAgentConfig() {
  return {
    provider: "openai_compatible" as const,
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1/chat/completions",
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    temperature: 0.2,
    allowLegalMoves: false
  };
}

function summarizeSeat(seat: PlayerSeat) {
  return {
    id: seat.id,
    seatIndex: seat.seatIndex,
    enabled: seat.enabled,
    kind: seat.kind,
    name: seat.name,
    ownerClientId: seat.ownerClientId ?? null,
    connected: seat.connected,
    score: seat.score,
    rackCount: seat.rackCount,
    model: seat.agentConfig?.model ?? null,
    provider: seat.agentConfig?.provider ?? null
  };
}

function summarizeSeats(seats: PlayerSeat[]) {
  return seats.map((seat) => summarizeSeat(seat));
}
