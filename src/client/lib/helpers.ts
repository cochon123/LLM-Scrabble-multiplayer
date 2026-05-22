import type { AgentConfig, AgentProvider, BoardCell, RoomSummary, RoomView, AgentTrace, AgentTraceDelta, AgentTraceChunk, AgentTraceEvent, ConversationMode } from "../../shared/types";
import type { ConversationItem } from "./types";

const CLIENT_ID_KEY = "scrabble-codex-client-id";

export function defaultBaseUrlForProvider(provider: AgentConfig["provider"]): string {
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

export function bonusClasses(bonus: BoardCell["bonus"]): string {
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

export function bonusLabelClasses(bonus: BoardCell["bonus"]): string {
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

export function labelBonus(bonus: BoardCell["bonus"]): string {
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

export function getModelLogo({ model, provider, name }: { model?: string; provider?: AgentProvider; name?: string }): string {
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
  return "/logos/bot.jpg";
}

export function getActiveTracePlayerId(traces: AgentTrace[]): string | null {
  return [...traces].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.playerId ?? null;
}

export function buildConversationFeed(view: RoomView | null, mode: ConversationMode, activeTracePlayerId: string | null): ConversationItem[] {
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

export function mergeTraceDelta(current: RoomView | null, payload: AgentTraceDelta): RoomView | null {
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

export function mergeTraceChunk(current: RoomView | null, payload: AgentTraceChunk): RoomView | null {
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

export function nextConversationMode(mode: ConversationMode): ConversationMode {
  if (mode === "user") return "advanced";
  if (mode === "advanced") return "dev";
  return "user";
}

export function modeLabel(mode: ConversationMode): string {
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

export function roomStatusLabel(status: RoomSummary["status"] | RoomView["status"]): string {
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

export function roomStatusBadge(status: RoomSummary["status"]): string {
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

export function traceEventClasses(event: AgentTraceEvent): { card: string; badge: string; content: string } {
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

export function parseRoute(pathname: string): import("./types").Route {
  const match = pathname.match(/^\/rooms\/([^/]+)$/);
  if (match) {
    return { page: "room", roomId: decodeURIComponent(match[1]) };
  }
  return { page: "home" };
}

export function navigateTo(setRoute: (route: import("./types").Route) => void, path: string) {
  window.history.pushState({}, "", path);
  setRoute(parseRoute(path));
}

export function getOrCreateClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

export function sanitizeAgentConfigForClientView(agentConfig: AgentConfig): AgentConfig {
  return {
    ...agentConfig,
    apiKey: "",
    hasCustomApiKey: Boolean(agentConfig.apiKey?.trim()) || Boolean(agentConfig.hasCustomApiKey)
  };
}
