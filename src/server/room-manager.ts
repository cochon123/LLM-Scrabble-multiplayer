import { nanoid } from "nanoid";
import type { Server, Socket } from "socket.io";
import { BOARD_SIZE, getBonus } from "../shared/constants.js";
import { Dictionary } from "../shared/dictionary.js";
import { ScrabbleGame } from "../shared/game.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt.js";
import type {
  AgentTrace,
  AgentTraceEvent,
  ChatMessage,
  ClientToServerEvents,
  CreateRoomPayload,
  ExchangeTilesPayload,
  JoinRoomPayload,
  PlayerSeat,
  RoomOptions,
  RoomView,
  SendChatPayload,
  ServerToClientEvents,
  StartGamePayload,
  SubmitMovePayload,
  TurnLog,
  UpdateRoomOptionsPayload,
  UpdateSeatPayload
} from "../shared/types.js";
import { runAgentTurn, warmUpAgentProvider } from "./ai.js";
import { appendRoomLog, getRoomLogPath } from "./logger.js";

type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type ConversationMessage = { role: "system" | "user" | "assistant"; content: string };

interface ClientRecord {
  clientId: string;
  displayName: string;
  socketId: string;
  roomId?: string;
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
  agentConversations: Record<string, ConversationMessage[]>;
  agentRunning: boolean;
  finishedLogged: boolean;
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
    const displayName = String(socket.handshake.auth.displayName || "Joueur");
    const existingClient = this.clients.get(clientId);
    const client: ClientRecord = {
      clientId,
      displayName,
      socketId: socket.id,
      roomId: existingClient?.roomId
    };
    this.clients.set(clientId, client);

    if (client.roomId) {
      socket.join(client.roomId);
      const room = this.rooms.get(client.roomId);
      if (room) {
        room.seats.forEach((seat) => {
          if (seat.ownerClientId === clientId) {
            seat.connected = true;
            if (!room.game) {
              seat.name = displayName;
            }
          }
        });
        this.syncRoom(room.id);
      }
    }

    socket.on("create_room", (payload: CreateRoomPayload) => this.handleCreateRoom(socket, clientId, payload));
    socket.on("join_room", (payload: JoinRoomPayload) => this.handleJoinRoom(socket, clientId, payload));
    socket.on("update_room_options", (payload: UpdateRoomOptionsPayload) => this.handleUpdateRoomOptions(clientId, payload));
    socket.on("update_seat", (payload: UpdateSeatPayload) => this.handleUpdateSeat(clientId, payload));
    socket.on("start_game", (payload: StartGamePayload) => this.handleStartGame(clientId, payload));
    socket.on("submit_move", (payload: SubmitMovePayload) => this.handleSubmitMove(clientId, payload));
    socket.on("exchange_tiles", (payload: ExchangeTilesPayload) => this.handleExchangeTiles(clientId, payload));
    socket.on("pass_turn", (payload: { roomId: string }) => this.handlePassTurn(clientId, payload.roomId));
    socket.on("send_chat", (payload: SendChatPayload) => this.handleSendChat(clientId, payload));
    socket.on("get_legal_moves", (payload: { roomId: string }) => this.handleGetLegalMoves(clientId, payload.roomId));

    socket.on("disconnect", () => {
      const disconnectedClient = this.clients.get(clientId);
      if (disconnectedClient) {
        disconnectedClient.socketId = "";
      }
      const room = disconnectedClient?.roomId ? this.rooms.get(disconnectedClient.roomId) : undefined;
      if (room) {
        room.seats.forEach((seat) => {
          if (seat.ownerClientId === clientId) {
            seat.connected = false;
          }
        });
        this.syncRoom(room.id);
      }
    });
  }

  private handleCreateRoom(socket: ClientSocket, clientId: string, payload: CreateRoomPayload): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.displayName = payload.displayName.trim() || "Joueur";
    client.socketId = socket.id;

    const roomId = nanoid(8);
    const hostSeat = createSeat(0, {
      enabled: true,
      kind: "human",
      name: client.displayName,
      ownerClientId: clientId,
      connected: true
    });
    const agentSeat = createSeat(1, {
      enabled: true,
      kind: "agent",
      name: "Agent Local",
      connected: true,
      agentConfig: defaultAgentConfig()
    });
    const room: RoomState = {
      id: roomId,
      hostClientId: clientId,
      options: {
        showLegalMoves: false
      },
      seats: [
        hostSeat,
        agentSeat,
        createSeat(2, { enabled: false, kind: "human", name: "Joueur 3" }),
        createSeat(3, { enabled: false, kind: "human", name: "Joueur 4" })
      ],
      chat: [
        systemChat("Salon créé. Configure les sièges puis lance la partie.")
      ],
      logs: [],
      agentTraces: {},
      agentConversations: {},
      agentRunning: false,
      finishedLogged: false
    };

    this.rooms.set(roomId, room);
    client.roomId = roomId;
    socket.join(roomId);
    this.logRoomEvent(room, "room_created", {
      hostClientId: clientId,
      hostName: client.displayName,
      logPath: getRoomLogPath(room.id),
      seats: summarizeSeats(room.seats),
      options: room.options
    });
    this.syncRoom(roomId);
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
      this.emitToClient(clientId, "error_message", "Impossible de modifier les options pendant la partie.");
      return;
    }

    room.options = {
      ...room.options,
      ...payload.patch
    };
    this.logRoomEvent(room, "room_options_updated", {
      updatedBy: clientId,
      options: room.options
    });
    this.syncRoom(room.id);
  }

  private handleJoinRoom(socket: ClientSocket, clientId: string, payload: JoinRoomPayload): void {
    const room = this.rooms.get(payload.roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) {
      socket.emit("error_message", "Salon introuvable.");
      return;
    }

    client.displayName = payload.displayName.trim() || client.displayName;
    client.socketId = socket.id;
    client.roomId = room.id;
    socket.join(room.id);

    const existingSeat = room.seats.find((seat) => seat.ownerClientId === clientId);
    if (existingSeat) {
      existingSeat.connected = true;
      if (!room.game) {
        existingSeat.name = client.displayName;
      }
    } else {
      const seat =
        room.seats.find((entry) => entry.enabled && entry.kind === "human" && !entry.ownerClientId) ??
        room.seats.find((entry) => !entry.enabled && entry.kind === "human");
      if (seat) {
        seat.enabled = true;
        seat.ownerClientId = clientId;
        seat.connected = true;
        seat.name = client.displayName;
      } else {
        socket.emit("error_message", "Salon complet.");
        return;
      }
    }

    room.chat.push(systemChat(`${client.displayName} a rejoint le salon.`));
    this.logRoomEvent(room, "player_joined", {
      clientId,
      displayName: client.displayName,
      seats: summarizeSeats(room.seats)
    });
    this.syncRoom(room.id);
  }

  private handleUpdateSeat(clientId: string, payload: UpdateSeatPayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room) {
      return;
    }
    if (room.hostClientId !== clientId) {
      this.emitToClient(clientId, "error_message", "Seul l'hôte peut configurer les sièges.");
      return;
    }
    if (room.game) {
      this.emitToClient(clientId, "error_message", "Impossible de modifier les sièges pendant la partie.");
      return;
    }

    const seat = room.seats.find((entry) => entry.id === payload.seatId);
    if (!seat) {
      return;
    }

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
      }
    }

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
      this.emitToClient(clientId, "error_message", "Seul l'hôte peut lancer la partie.");
      return;
    }

    const activeSeats = room.seats.filter((seat) => seat.enabled);
    if (activeSeats.length < 2) {
      this.emitToClient(clientId, "error_message", "Il faut au moins deux joueurs actifs.");
      return;
    }

    const invalidHumanSeat = activeSeats.find((seat) => seat.kind === "human" && !seat.ownerClientId);
    if (invalidHumanSeat) {
      this.emitToClient(clientId, "error_message", "Tous les sièges humains actifs doivent être occupés.");
      return;
    }

    room.game = new ScrabbleGame(room.id, this.dictionary, activeSeats);
    room.game.start();
    room.chat.push(systemChat("La partie commence."));
    room.finishedLogged = false;
    this.logRoomEvent(room, "game_started", {
      seats: summarizeSeats(activeSeats),
      firstPlayerId: room.game.getCurrentPlayer()?.id ?? null,
      firstPlayerName: room.game.getCurrentPlayer()?.name ?? null
    });
    for (const seat of activeSeats.filter((entry) => entry.kind === "agent")) {
      void warmUpAgentProvider(seat.agentConfig);
    }
    this.syncRoom(room.id);
    void this.runAgentIfNeeded(room.id);
  }

  private handleSubmitMove(clientId: string, payload: SubmitMovePayload): void {
    const room = this.rooms.get(payload.roomId);
    const playerId = room ? this.getRoomPlayerId(room, clientId) : null;
    if (!room || !room.game || !playerId) {
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
    if (!room) {
      return;
    }

    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    room.chat.push({
      id: nanoid(),
      authorId: clientId,
      authorName: client.displayName,
      kind: "human",
      text: payload.text.trim(),
      createdAt: Date.now()
    });
    this.logRoomEvent(room, "human_chat", {
      clientId,
      authorName: client.displayName,
      text: payload.text.trim()
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
    if (!room.options.showLegalMoves) {
      this.logRoomEvent(room, "human_legal_moves_rejected", {
        playerId,
        reason: "feature_disabled"
      });
      this.emitToClient(clientId, "error_message", "Les coups légaux sont désactivés pour cette partie.");
      return;
    }
    const moves = room.game.listLegalMoves(playerId, 12);
    this.logRoomEvent(room, "human_legal_moves_requested", {
      playerId,
      count: moves.length
    });
    this.io.to(client.socketId).emit("legal_moves", moves);
  }

  private async runAgentIfNeeded(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || !room.game || room.agentRunning || room.game.isFinished()) {
      return;
    }
    const currentPlayer = room.game.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.kind !== "agent") {
      return;
    }

    room.agentRunning = true;
    this.logRoomEvent(room, "agent_turn_started", {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      provider: currentPlayer.agentConfig?.provider ?? null,
      model: currentPlayer.agentConfig?.model ?? null,
      allowLegalMoves: Boolean(currentPlayer.agentConfig?.allowLegalMoves),
      rack: currentPlayer.rack.map((tile) => (tile.blank ? "?" : tile.letter))
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    try {
      const result = await runAgentTurn(currentPlayer.id, currentPlayer.agentConfig, {
        roomId,
        game: room.game,
        recentChat: room.chat,
        logs: room.logs,
        pushChat: (playerId: string, text: string) => this.pushAgentChat(room, playerId, text),
        beginTrace: (trace: AgentTrace) => {
          const existing = room.agentTraces[trace.playerId];
          room.agentTraces[trace.playerId] = existing
            ? {
                ...existing,
                playerName: trace.playerName,
                provider: trace.provider,
                model: trace.model,
                systemPrompt: trace.systemPrompt,
                updatedAt: trace.updatedAt,
                events:
                  existing.systemPrompt === trace.systemPrompt
                    ? existing.events
                    : [...existing.events, ...trace.events].slice(-240)
              }
            : trace;
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
          }
        },
        pushTraceEvent: (playerId: string, event: AgentTraceEvent) => {
          const existing = room.agentTraces[playerId];
          if (!existing) {
            return;
          }
          existing.events = [...existing.events, event].slice(-240);
          existing.updatedAt = event.createdAt;
          this.logRoomEvent(room, "agent_trace_event", {
            playerId,
            playerName: existing.playerName,
            eventKind: event.kind,
            title: event.title,
            content: event.content
          });
        },
        getConversation: (playerId: string) => room.agentConversations[playerId] ?? [],
        setConversation: (playerId: string, messages: ConversationMessage[]) => {
          room.agentConversations[playerId] = messages.slice(-240);
        }
      });
      const snapshot = room.game.getSnapshot();
      this.logRoomEvent(room, "agent_turn_completed", {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        done: result.done,
        summary: result.summary,
        nextPlayerId: snapshot.currentPlayerId
      });
      if (result.done && snapshot.lastMove) {
        room.logs.push(snapshot.lastMove);
        this.logRoomEvent(room, "agent_move_applied", {
          playerId: currentPlayer.id,
          move: snapshot.lastMove,
          nextPlayerId: snapshot.currentPlayerId
        });
      }
      this.logGameFinishedIfNeeded(room);
    } finally {
      room.agentRunning = false;
      this.syncRoom(roomId);
      if (room.game && !room.game.isFinished()) {
        void this.runAgentIfNeeded(roomId);
      }
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
    this.logRoomEvent(room, "agent_chat", {
      playerId,
      authorName: message.authorName,
      text
    });
    this.syncRoom(room.id);
    return message;
  }

  private logRoomEvent(room: RoomState, type: string, payload: Record<string, unknown>): void {
    const snapshot = room.game?.getSnapshot();
    appendRoomLog(room.id, type, {
      turn: snapshot?.turn ?? null,
      currentPlayerId: snapshot?.currentPlayerId ?? null,
      finished: snapshot?.finished ?? false,
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
      const view = this.buildRoomView(room, client.clientId);
      this.io.to(client.socketId).emit("sync", view);
    }
  }

  private buildRoomView(room: RoomState, clientId: string): RoomView {
    const playerId = this.getRoomPlayerId(room, clientId);
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
      options: room.options,
      game,
      chat: room.chat.slice(-80),
      logs: room.logs.slice(-80),
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
    this.io.to(client.socketId).emit("legal_moves", payload as never);
  }
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
    allowLegalMoves: false
  };
}

function summarizeSeats(seats: PlayerSeat[]) {
  return seats.map((seat) => summarizeSeat(seat));
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
    provider: seat.agentConfig?.provider ?? null,
    model: seat.agentConfig?.model ?? null,
    allowLegalMoves: Boolean(seat.agentConfig?.allowLegalMoves)
  };
}
