export type BonusType = "normal" | "dl" | "tl" | "dw" | "tw" | "center";
export type Direction = "horizontal" | "vertical";
export type SeatKind = "human" | "agent";
export type AgentProvider = "openai_compatible" | "openrouter" | "google" | "ollama";

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
  kind: "human" | "agent" | "system";
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
  options: RoomOptions;
  game: GameSnapshot;
  chat: ChatMessage[];
  logs: TurnLog[];
  agentTraces: AgentTrace[];
}

export interface CreateRoomPayload {
  displayName: string;
}

export interface JoinRoomPayload {
  roomId: string;
  displayName: string;
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

export interface ServerToClientEvents {
  sync: (view: RoomView) => void;
  error_message: (message: string) => void;
  legal_moves: (moves: LegalMove[]) => void;
}

export interface ClientToServerEvents {
  create_room: (payload: CreateRoomPayload) => void;
  join_room: (payload: JoinRoomPayload) => void;
  update_room_options: (payload: UpdateRoomOptionsPayload) => void;
  update_seat: (payload: UpdateSeatPayload) => void;
  start_game: (payload: StartGamePayload) => void;
  submit_move: (payload: SubmitMovePayload) => void;
  exchange_tiles: (payload: ExchangeTilesPayload) => void;
  pass_turn: (payload: { roomId: string }) => void;
  send_chat: (payload: SendChatPayload) => void;
  get_legal_moves: (payload: LegalMovesPayload) => void;
}
