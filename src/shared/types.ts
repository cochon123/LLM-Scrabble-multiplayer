export type BonusType = "normal" | "dl" | "tl" | "dw" | "tw" | "center";
export type Direction = "horizontal" | "vertical";
export type SeatKind = "human" | "agent";
export type AgentProvider = "openai_compatible" | "openrouter" | "google" | "ollama";
export type ViewerRole = "player" | "spectator";
export type RoomStatus = "lobby" | "live" | "paused" | "finished";
export type ConversationMode = "user" | "advanced" | "dev";
export type TraceVisibilityMode = ConversationMode;
export type DefaultApiKeys = Partial<Record<AgentProvider, string>>;

export interface AuthUserView {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  defaultApiKeys: DefaultApiKeys;
}

export interface Tile {
  id: string;
  letter: string;
  value: number;
  blank: boolean;
  assignedLetter?: string;
}

export interface Coord {
  row: number;
  col: number;
}

export interface BoardCell extends Coord {
  bonus: BonusType;
  tile: Tile | null;
}

export interface PlacementInput extends Coord {
  tileId: string;
  letter?: string;
}

export interface LegalMove {
  placements: PlacementInput[];
  score: number;
  formedWords: string[];
  summary: string;
}

export interface AgentTraceEvent {
  id: string;
  kind: "prompt" | "context" | "reasoning" | "provider_reply" | "tool_call" | "tool_result" | "status";
  title: string;
  content: string;
  createdAt: number;
}

export interface AgentTrace {
  playerId: string;
  playerName: string;
  provider: AgentProvider;
  model: string;
  updatedAt: number;
  systemPrompt: string;
  turnCount: number;
  fallbackCount: number;
  events: AgentTraceEvent[];
}

export interface RoomOptions {
  showLegalMoves: boolean;
}

export interface AgentConfig {
  provider: AgentProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  allowLegalMoves?: boolean;
}

export interface PlayerSeat {
  id: string;
  seatIndex: number;
  enabled: boolean;
  kind: SeatKind;
  name: string;
  ownerClientId?: string | null;
  connected: boolean;
  score: number;
  rackCount: number;
  rack?: Tile[];
  isCurrentTurn: boolean;
  isHost?: boolean;
  agentConfig?: AgentConfig;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  kind: "human" | "agent" | "system" | "spectator";
  text: string;
  createdAt: number;
}

export interface TurnLog {
  id: string;
  playerId: string;
  playerName: string;
  action: "play" | "exchange" | "pass" | "chat";
  summary: string;
  scoreDelta: number;
  createdAt: number;
}

export interface GameSnapshot {
  id: string;
  board: BoardCell[][];
  players: PlayerSeat[];
  currentPlayerId: string | null;
  turn: number;
  bagCount: number;
  scorelessTurns: number;
  started: boolean;
  finished: boolean;
  winnerIds: string[];
  lastMove?: TurnLog;
}

export interface RoomView {
  roomId: string;
  hostClientId: string;
  joinedClientId: string;
  playerId?: string | null;
  viewerRole: ViewerRole;
  paused: boolean;
  status: RoomStatus;
  spectatorCount: number;
  options: RoomOptions;
  game: GameSnapshot;
  chat: ChatMessage[];
  logs: TurnLog[];
  agentTraces: AgentTrace[];
}

export interface RoomSeatSummary {
  id: string;
  seatIndex: number;
  name: string;
  kind: SeatKind;
  enabled: boolean;
  connected: boolean;
  occupied: boolean;
  score: number;
  isCurrentTurn: boolean;
}

export interface RoomSummary {
  roomId: string;
  status: RoomStatus;
  started: boolean;
  finished: boolean;
  paused: boolean;
  playerCount: number;
  spectatorCount: number;
  hostName: string;
  seatSummaries: RoomSeatSummary[];
  currentTurnPlayerName: string | null;
  updatedAt: number;
}

export interface RoomDirectoryResponse {
  rooms: RoomSummary[];
}

export interface CreateRoomPayload {
  displayName: string;
}

export interface JoinRoomPayload {
  roomId: string;
  displayName: string;
}

export interface WatchRoomPayload {
  roomId: string;
  displayName?: string;
}

export interface UpdateSeatPayload {
  roomId: string;
  seatId: string;
  patch: Partial<Pick<PlayerSeat, "name" | "kind" | "enabled">> & {
    agentConfig?: AgentConfig;
  };
}

export interface StartGamePayload {
  roomId: string;
}

export interface UpdateRoomOptionsPayload {
  roomId: string;
  patch: Partial<RoomOptions>;
}

export interface SubmitMovePayload {
  roomId: string;
  placements: PlacementInput[];
}

export interface ExchangeTilesPayload {
  roomId: string;
  tileIds: string[];
}

export interface SendChatPayload {
  roomId: string;
  text: string;
}

export interface LegalMovesPayload {
  roomId: string;
}

export interface TogglePausePayload {
  roomId: string;
}

export interface RoomPausePayload {
  roomId: string;
  paused: boolean;
}

export interface AgentTraceDelta {
  playerId: string;
  event: AgentTraceEvent;
}

export interface AgentTraceChunk {
  playerId: string;
  eventId: string;
  kind: AgentTraceEvent["kind"];
  append: string;
  done: boolean;
}

export interface ServerToClientEvents {
  sync: (view: RoomView) => void;
  error_message: (message: string) => void;
  legal_moves: (moves: LegalMove[]) => void;
  agent_trace_delta: (payload: AgentTraceDelta) => void;
  agent_trace_chunk: (payload: AgentTraceChunk) => void;
  room_pause_state: (payload: RoomPausePayload) => void;
}

export interface ClientToServerEvents {
  create_room: (payload: CreateRoomPayload) => void;
  leave_room: () => void;
  watch_room: (payload: WatchRoomPayload) => void;
  join_room: (payload: JoinRoomPayload) => void;
  update_room_options: (payload: UpdateRoomOptionsPayload) => void;
  update_seat: (payload: UpdateSeatPayload) => void;
  start_game: (payload: StartGamePayload) => void;
  submit_move: (payload: SubmitMovePayload) => void;
  exchange_tiles: (payload: ExchangeTilesPayload) => void;
  pass_turn: (payload: { roomId: string }) => void;
  send_chat: (payload: SendChatPayload) => void;
  get_legal_moves: (payload: LegalMovesPayload) => void;
  toggle_pause: (payload: TogglePausePayload) => void;
}
