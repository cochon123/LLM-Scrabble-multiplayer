import type { ChatMessage, AgentTrace, AgentTraceEvent, ConversationMode } from "../../shared/types";

export type ConversationItem =
  | { id: string; createdAt: number; order: number; type: "chat"; message: ChatMessage }
  | { id: string; createdAt: number; order: number; type: "trace"; trace: AgentTrace; event: AgentTraceEvent };

export type Route = { page: "home" } | { page: "room"; roomId: string };

export type PendingAction =
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
