import { nanoid } from "nanoid";
import { resolveAgentSystemPrompt } from "../shared/agent-prompt.js";
import { ScrabbleGame } from "../shared/game.js";
import type { AgentConfig, AgentTrace, AgentTraceEvent, ChatMessage, LegalMove, PlacementInput, Tile, TurnLog } from "../shared/types.js";

interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

interface AgentRoomContext {
  game: ScrabbleGame;
  roomId: string;
  signal: AbortSignal;
  isPaused: () => boolean;
  logDiagnostic: (type: string, payload: Record<string, unknown>) => void;
  getPublicTimeline: () => PublicTimelineEntry[];
  pushChat: (playerId: string, text: string) => ChatMessage;
  pushSystemChat: (text: string) => ChatMessage;
  beginTrace: (trace: AgentTrace) => void;
  pushTraceEvent: (playerId: string, event: AgentTraceEvent) => void;
  startTraceEvent: (playerId: string, event: AgentTraceEvent) => void;
  appendTraceChunk: (payload: { playerId: string; eventId: string; kind: AgentTraceEvent["kind"]; append: string; done: boolean }) => void;
  getAgentState: (playerId: string) => AgentConversationState;
  setAgentState: (playerId: string, state: AgentConversationState) => void;
}

interface ToolResult {
  done: boolean;
  summary: string;
  aborted?: boolean;
}

interface AgentPlacement {
  row: number;
  col: number;
  letter: string;
}

interface ProviderReply {
  text: string;
  reasoning?: string;
}

interface ProviderCallbacks {
  onTextChunk: (chunk: string) => void;
  onReasoningChunk: (chunk: string) => void;
}

interface OpenAICompatibleRequestVariant {
  label: string;
  body: Record<string, unknown>;
  allowFallback: boolean;
}

const PROVIDER_TIMEOUT_MS = 300_000;

class ProviderTransportError extends Error {
  retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ProviderTransportError";
    this.retryable = retryable;
  }
}

export async function runAgentTurn(
  playerId: string,
  agentConfig: AgentConfig | undefined,
  context: AgentRoomContext
): Promise<ToolResult> {
  const player = context.game.getPlayer(playerId);
  if (!player) {
    return { done: false, summary: "Agent not found." };
  }
  if (!agentConfig) {
    return runFallbackTurn(playerId, context, false);
  }

  const systemPrompt = resolveAgentSystemPrompt(agentConfig.systemPrompt, {
    allowLegalMoves: agentConfig.allowLegalMoves
  });
  const legalMovesAllowed = Boolean(agentConfig.allowLegalMoves);
  context.beginTrace({
    playerId,
    playerName: player.name,
    provider: agentConfig.provider,
    model: agentConfig.model,
    updatedAt: Date.now(),
    systemPrompt,
    turnCount: 1,
    fallbackCount: 0,
    events: []
  });

  let state = context.getAgentState(playerId);
  let conversation = state.messages.slice();
  if (conversation.length === 0 || conversation[0]?.role !== "system" || conversation[0]?.content !== systemPrompt) {
    conversation = [{ role: "system", content: systemPrompt }];
    state = {
      ...state,
      messages: conversation,
      initialized: false,
      lastPublicEventIndex: 0,
      knownBoard: null
    };
  }

  const turnContext = state.initialized
    ? buildTurnContext(context, playerId, state)
    : buildInitialContext(context, playerId);
  context.pushTraceEvent(playerId, createTraceEvent("context", "Context", turnContext));
  conversation = [...conversation, { role: "user", content: turnContext }];
  state = {
    ...state,
    messages: conversation,
    initialized: true,
    lastPublicEventIndex: context.getPublicTimeline().length,
    knownBoard: snapshotBoard(context.game.getSnapshot(playerId).board)
  };
  context.setAgentState(playerId, state);

  for (let step = 0; step < 6; step += 1) {
    if (context.isPaused()) {
      const pausedResult = { done: false, summary: "Turn interrupted by pause.", aborted: true };
      context.pushTraceEvent(playerId, createTraceEvent("status", "Pause", pausedResult.summary));
      context.setAgentState(playerId, state);
      return pausedResult;
    }

    const reasoningEvent = createTraceEvent("reasoning", `Reasoning ${step + 1}`, "");
    const providerReplyEvent = createTraceEvent("provider_reply", `Model reply ${step + 1}`, "");
    let reasoningOpened = false;
    let replyOpened = false;

    let providerReply: ProviderReply;
    try {
      providerReply = await callProvider(agentConfig, conversation, context.signal, {
        onReasoningChunk: (chunk) => {
          if (!chunk) {
            return;
          }
          if (!reasoningOpened) {
            context.startTraceEvent(playerId, reasoningEvent);
            reasoningOpened = true;
          }
          context.appendTraceChunk({
            playerId,
            eventId: reasoningEvent.id,
            kind: "reasoning",
            append: chunk,
            done: false
          });
        },
        onTextChunk: (chunk) => {
          if (!chunk) {
            return;
          }
          if (!replyOpened) {
            context.startTraceEvent(playerId, providerReplyEvent);
            replyOpened = true;
          }
          context.appendTraceChunk({
            playerId,
            eventId: providerReplyEvent.id,
            kind: "provider_reply",
            append: chunk,
            done: false
          });
        }
      }, (type, payload) => context.logDiagnostic(`agent_provider_${type}`, { playerId, ...payload }));
    } catch (error) {
      if (isAbortError(error)) {
        const pausedResult = { done: false, summary: "Turn interrupted by pause.", aborted: true };
        context.pushTraceEvent(playerId, createTraceEvent("status", "Pause", pausedResult.summary));
        context.setAgentState(playerId, state);
        return pausedResult;
      }
      context.setAgentState(playerId, state);
      context.pushTraceEvent(playerId, createTraceEvent("status", "Fallback", "Provider failure. Switching to the fallback engine."));
      return runFallbackTurn(playerId, context, legalMovesAllowed);
    }

    if (reasoningOpened) {
      context.appendTraceChunk({
        playerId,
        eventId: reasoningEvent.id,
        kind: "reasoning",
        append: "",
        done: true
      });
    } else if (providerReply.reasoning?.trim()) {
      context.pushTraceEvent(playerId, createTraceEvent("reasoning", `Reasoning ${step + 1}`, providerReply.reasoning));
    }

    if (replyOpened) {
      context.appendTraceChunk({
        playerId,
        eventId: providerReplyEvent.id,
        kind: "provider_reply",
        append: "",
        done: true
      });
    } else {
      context.pushTraceEvent(playerId, createTraceEvent("provider_reply", `Model reply ${step + 1}`, providerReply.text || "(empty)"));
    }

    conversation = [...conversation, { role: "assistant", content: providerReply.text || "(empty)" }];

    const command = parseToolCommand(providerReply.text);
    if (!command) {
      const reminder = [
        "Invalid response. You must return a single JSON object {tool, arguments}.",
        "The game is played in English.",
        "row/col coordinates are 0-indexed."
      ].join("\n");
      context.pushTraceEvent(playerId, createTraceEvent("status", "Invalid response", providerReply.text || "(empty)"));
      conversation = [...conversation, { role: "user", content: reminder }];
      state = { ...state, messages: conversation };
      context.setAgentState(playerId, state);
      continue;
    }

    context.pushTraceEvent(playerId, createTraceEvent("tool_call", `Tool call ${step + 1}`, JSON.stringify(command, null, 2)));
    const result = executeTool(command.tool, command.arguments, playerId, context, legalMovesAllowed);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", `Result ${step + 1}`, result.summary));

    if (result.done || result.aborted) {
      state = {
        ...state,
        messages: conversation
      };
      context.setAgentState(playerId, state);
      return result;
    }

    const updatedPlayer = context.game.getPlayer(playerId);
    const retryMessage = [
      `Tool result: ${result.summary}`,
      `Current rack: ${updatedPlayer ? formatRack(updatedPlayer.rack) : "(player not found)"}`,
      "Reminder: the game is played in English.",
      "Reminder: all tool row/col coordinates are 0-indexed."
    ].join("\n");
    conversation = [...conversation, { role: "user", content: retryMessage }];
    state = { ...state, messages: conversation };
    context.setAgentState(playerId, state);
  }

  context.setAgentState(playerId, state);
  context.pushTraceEvent(playerId, createTraceEvent("status", "Fallback", "No valid final action was produced. Switching to the fallback engine."));
  return runFallbackTurn(playerId, context, legalMovesAllowed);
}

export async function warmUpAgentProvider(agentConfig: AgentConfig | undefined): Promise<void> {
  if (!agentConfig) {
    return;
  }

  try {
    switch (agentConfig.provider) {
      case "openai_compatible": {
        const baseUrl = agentConfig.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || "http://127.0.0.1:1234/v1/chat/completions";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apiKey = agentConfig.apiKey || process.env.OPENAI_API_KEY;
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        await fetch(baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: agentConfig.model,
            max_tokens: 4,
            temperature: 0,
            messages: [
              { role: "system", content: "Reply with OK." },
              { role: "user", content: "Warmup" }
            ]
          })
        });
        return;
      }
      case "openrouter": {
        const apiKey = agentConfig.apiKey || process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return;
        }
        await fetch(agentConfig.baseUrl || "https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://scrabble-codex.local",
            "X-Title": "Scrabble Codex"
          },
          body: JSON.stringify({
            model: agentConfig.model,
            max_tokens: 4,
            temperature: 0,
            messages: [
              { role: "system", content: "Reply with OK." },
              { role: "user", content: "Warmup" }
            ]
          })
        });
        return;
      }
      case "ollama": {
        await fetch(agentConfig.baseUrl || "http://127.0.0.1:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: agentConfig.model,
            stream: false,
            keep_alive: "15m",
            options: { temperature: 0 },
            messages: [
              { role: "system", content: "Reply with OK." },
              { role: "user", content: "Warmup" }
            ]
          })
        });
        return;
      }
      default:
        return;
    }
  } catch {
    return;
  }
}

function buildInitialContext(context: AgentRoomContext, playerId: string): string {
  const snapshot = context.game.getSnapshot(playerId);
  const player = context.game.getPlayer(playerId);
  const occupiedTiles = summarizeBoardDelta(null, snapshot.board);
  const timeline = context.getPublicTimeline().slice(-24).map((entry) => `${formatTimelineDate(entry.createdAt)} ${entry.text}`);

  return JSON.stringify(
    {
      room_id: context.roomId,
      rules: {
        language: "en",
        coordinates: "0-indexed",
        center: { row: 7, col: 7 }
      },
      private_state: {
        me: {
          id: player?.id ?? null,
          name: player?.name ?? null,
          rack: player?.rack.map((tile) => (tile.blank ? "?" : tile.letter)) ?? []
        },
        turn: snapshot.turn,
        bagCount: snapshot.bagCount,
        currentPlayerId: snapshot.currentPlayerId,
        players: snapshot.players.map((seat) => ({
          id: seat.id,
          name: seat.name,
          score: seat.score
        }))
      },
      public_timeline: timeline,
      board_state_summary: occupiedTiles,
      instruction: "Your turn. Reply only with a JSON tool call."
    },
    null,
    2
  );
}

function buildTurnContext(context: AgentRoomContext, playerId: string, state: AgentConversationState): string {
  const snapshot = context.game.getSnapshot(playerId);
  const player = context.game.getPlayer(playerId);
  const timeline = context.getPublicTimeline();
  const publicDelta = timeline
    .slice(state.lastPublicEventIndex)
    .map((entry) => `${formatTimelineDate(entry.createdAt)} ${entry.text}`);
  const boardDelta = summarizeBoardDelta(state.knownBoard, snapshot.board);

  return JSON.stringify(
    {
      private_state: {
        rack: player?.rack.map((tile) => (tile.blank ? "?" : tile.letter)) ?? [],
        bagCount: snapshot.bagCount,
        turn: snapshot.turn,
        currentPlayerId: snapshot.currentPlayerId,
        players: snapshot.players.map((seat) => ({
          id: seat.id,
          name: seat.name,
          score: seat.score
        }))
      },
      public_timeline_delta: publicDelta,
      board_delta: boardDelta,
      last_public_move: snapshot.lastMove
        ? {
            playerName: snapshot.lastMove.playerName,
            action: snapshot.lastMove.action,
            summary: snapshot.lastMove.summary
          }
        : null,
      instruction: "Your turn. Choose a legal final action through a JSON tool call."
    },
    null,
    2
  );
}

async function callProvider(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  switch (config.provider) {
    case "openai_compatible":
      return callOpenAICompatible(config, messages, signal, callbacks, diagnostics);
    case "openrouter":
      return callOpenRouter(config, messages, signal, callbacks, diagnostics);
    case "google":
      return callGoogle(config, messages, signal, callbacks, diagnostics);
    case "ollama":
      return callOllama(config, messages, signal, callbacks, diagnostics);
    default:
      throw new Error("Unsupported provider");
  }
}

async function callOpenAICompatible(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  const baseUrl = config.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || "http://127.0.0.1:1234/v1/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const baseBody = {
    model: config.model,
    temperature: config.temperature ?? 0.2,
    stream: true,
    messages
  };
  const requestVariants = buildOpenAICompatibleRequestVariants(config, baseBody);
  let lastError: unknown;

  for (const variant of requestVariants) {
    diagnostics?.("provider_reasoning_variant_selected", {
      provider: "openai_compatible",
      model: config.model,
      label: variant.label,
      extras: Object.keys(variant.body).filter((key) => !["model", "temperature", "stream", "messages"].includes(key))
    });
    try {
      return await callStreamProviderWithRetries("openai_compatible", baseUrl, headers, variant.body, signal, callbacks, diagnostics);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error;
      if (!variant.allowFallback || !isPossiblyUnsupportedRequestError(error)) {
        throw error;
      }
      diagnostics?.("provider_reasoning_variant_rejected", {
        provider: "openai_compatible",
        model: config.model,
        label: variant.label,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callOpenRouter(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }
  const url = config.baseUrl || "https://openrouter.ai/api/v1/chat/completions";
  return callStreamProviderWithRetries(
    "openrouter",
    url,
    {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "HTTP-Referer": "https://scrabble-codex.local",
      "X-Title": "Scrabble Codex"
    },
    {
      model: config.model,
      temperature: config.temperature ?? 0.2,
      stream: true,
      messages,
      reasoning: {
        enabled: true,
        exclude: false
      }
    },
    signal,
    callbacks,
    diagnostics
  );
}

async function callGoogle(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY");
  }

  const model = config.model || "gemini-2.5-flash";
  const [systemMessage, ...restMessages] = messages;
  const requestSignal = withTimeout(signal, PROVIDER_TIMEOUT_MS);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  diagnostics?.("provider_request_started", {
    provider: "google",
    url,
    model,
    messageCount: messages.length
  });
  const response = await fetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: requestSignal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemMessage?.content ?? "" }]
        },
        contents: restMessages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        })),
        generationConfig: {
          temperature: config.temperature ?? 0.2,
          thinkingConfig: buildGoogleThinkingConfig(model)
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Google AI error ${response.status}`);
  }

  diagnostics?.("provider_response_headers", {
    provider: "google",
    contentType: response.headers.get("content-type") ?? null,
    status: response.status
  });

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; thought?: boolean }>;
      };
    }>;
  };

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  let reasoning = "";
  for (const part of parts) {
    const partText = part.text ?? "";
    if (!partText) {
      continue;
    }
    if (part.thought) {
      reasoning += partText;
    } else {
      text += partText;
    }
  }
  if (reasoning) {
    await emitBufferedChunks(reasoning, callbacks.onReasoningChunk, requestSignal);
  }
  if (text) {
    await emitBufferedChunks(text, callbacks.onTextChunk, requestSignal);
  }
  return { text, reasoning: reasoning || undefined };
}

async function callOllama(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  const requestSignal = withTimeout(signal, PROVIDER_TIMEOUT_MS);
  const url = config.baseUrl || "http://127.0.0.1:11434/api/chat";
  diagnostics?.("provider_request_started", {
    provider: "ollama",
    url,
    model: config.model,
    messageCount: messages.length
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal: requestSignal,
    body: JSON.stringify({
      model: config.model,
      stream: true,
      think: true,
      options: {
        temperature: config.temperature ?? 0.2
      },
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}`);
  }

  diagnostics?.("provider_response_headers", {
    provider: "ollama",
    contentType: response.headers.get("content-type") ?? null,
    status: response.status
  });

  if (!response.body) {
    throw new Error("Ollama response body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    throwIfAborted(requestSignal);
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const data = JSON.parse(trimmed) as {
        message?: { content?: string; thinking?: string };
      };
      const nextText = data.message?.content ?? "";
      const nextReasoning = data.message?.thinking ?? "";
      if (nextReasoning) {
        reasoning += nextReasoning;
        callbacks.onReasoningChunk(nextReasoning);
      }
      if (nextText) {
        text += nextText;
        callbacks.onTextChunk(nextText);
      }
    }
  }

  if (buffer.trim()) {
    const data = JSON.parse(buffer.trim()) as {
      message?: { content?: string; thinking?: string };
    };
    const nextText = data.message?.content ?? "";
    const nextReasoning = data.message?.thinking ?? "";
    if (nextReasoning) {
      reasoning += nextReasoning;
      callbacks.onReasoningChunk(nextReasoning);
    }
    if (nextText) {
      text += nextText;
      callbacks.onTextChunk(nextText);
    }
  }

  diagnostics?.("provider_stream_completed", {
    provider: "ollama",
    textChars: text.length,
    reasoningChars: reasoning.length
  });

  return { text, reasoning };
}

function buildOpenAICompatibleRequestVariants(
  config: AgentConfig,
  baseBody: Record<string, unknown>
): OpenAICompatibleRequestVariant[] {
  const model = (config.model || "").toLowerCase();
  const variants: OpenAICompatibleRequestVariant[] = [];

  const withDeepSeekThinking =
    model.includes("deepseek") || model.includes("reasoner")
      ? {
          ...baseBody,
          thinking: {
            type: "enabled"
          }
        }
      : null;

  const withReasoningEffort =
    supportsReasoningEffort(model)
      ? {
          ...baseBody,
          reasoning_effort: "high"
        }
      : null;

  if (withDeepSeekThinking && withReasoningEffort) {
    variants.push({
      label: "thinking+reasoning_effort",
      body: {
        ...withDeepSeekThinking,
        reasoning_effort: "high"
      },
      allowFallback: true
    });
  }

  if (withDeepSeekThinking) {
    variants.push({
      label: "thinking",
      body: withDeepSeekThinking,
      allowFallback: true
    });
  }

  if (withReasoningEffort) {
    variants.push({
      label: "reasoning_effort",
      body: withReasoningEffort,
      allowFallback: true
    });
  }

  variants.push({
    label: "plain",
    body: baseBody,
    allowFallback: false
  });

  return dedupeOpenAICompatibleVariants(variants);
}

function dedupeOpenAICompatibleVariants(variants: OpenAICompatibleRequestVariant[]): OpenAICompatibleRequestVariant[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant.body);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function supportsReasoningEffort(model: string): boolean {
  return /gpt-5|o1|o3|o4|grok/i.test(model);
}

function buildGoogleThinkingConfig(model: string): Record<string, unknown> {
  if (/gemini-3/i.test(model)) {
    return {
      includeThoughts: true,
      thinkingLevel: "high"
    };
  }

  return {
    includeThoughts: true,
    thinkingBudget: 1024
  };
}

async function readProviderResponse(
  response: Response,
  callbacks: ProviderCallbacks,
  signal: AbortSignal,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || contentType.includes("application/json")) {
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const reasoning = data.choices?.[0]?.message?.reasoning;
    if (reasoning) {
      callbacks.onReasoningChunk(reasoning);
    }
    if (text) {
      callbacks.onTextChunk(text);
    }
    diagnostics?.("provider_buffered_response", {
      contentType,
      textChars: text.length,
      reasoningChars: reasoning?.length ?? 0
    });
    if (!text.trim() && !reasoning?.trim()) {
      throw new ProviderTransportError("Provider response was empty or had no usable content.", true);
    }
    return { text, reasoning };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let frameCount = 0;
  let jsonFrameCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    throwIfAborted(signal);
    buffer += decoder.decode(value, { stream: true });
    const frames = splitSseFrames(buffer);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      frameCount += 1;
      const payload = extractSseDataPayload(frame);
      if (!payload || payload === "[DONE]") {
        continue;
      }
      try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        jsonFrameCount += 1;
        const { textChunk, reasoningChunk } = extractSseChunks(data);
        if (reasoningChunk) {
          reasoning += reasoningChunk;
          callbacks.onReasoningChunk(reasoningChunk);
        }
        if (textChunk) {
          text += textChunk;
          callbacks.onTextChunk(textChunk);
        }
      } catch (error) {
        diagnostics?.("provider_stream_json_parse_failed", {
          frameCount,
          payloadPreview: payload.slice(0, 400),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const trailingPayload = extractSseDataPayload(buffer);
  if (trailingPayload && trailingPayload !== "[DONE]") {
    try {
      const data = JSON.parse(trailingPayload) as Record<string, unknown>;
      jsonFrameCount += 1;
      const { textChunk, reasoningChunk } = extractSseChunks(data);
      if (reasoningChunk) {
        reasoning += reasoningChunk;
        callbacks.onReasoningChunk(reasoningChunk);
      }
      if (textChunk) {
        text += textChunk;
        callbacks.onTextChunk(textChunk);
      }
    } catch (error) {
      diagnostics?.("provider_stream_trailing_json_parse_failed", {
        payloadPreview: trailingPayload.slice(0, 400),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  diagnostics?.("provider_stream_completed", {
    contentType,
    frameCount,
    jsonFrameCount,
    textChars: text.length,
    reasoningChars: reasoning.length
  });

  if (!text.trim() && !reasoning.trim()) {
    throw new ProviderTransportError("Provider stream ended without text or reasoning.", true);
  }

  return {
    text,
    reasoning: reasoning || undefined
  };
}

function extractSseChunks(data: Record<string, unknown>): { textChunk: string; reasoningChunk: string } {
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const delta = choice && typeof choice === "object" && "delta" in choice ? (choice.delta as Record<string, unknown>) : undefined;
  const message = choice && typeof choice === "object" && "message" in choice ? (choice.message as Record<string, unknown>) : undefined;

  const textChunk =
    stringValue(delta?.content) ||
    joinTextParts(delta?.content) ||
    stringValue(message?.content) ||
    "";

  const reasoningChunk =
    stringValue(delta?.reasoning) ||
    stringValue(delta?.reasoning_content) ||
    stringValue(delta?.thinking) ||
    joinTextParts(delta?.reasoning_content) ||
    joinTextParts(delta?.thinking) ||
    stringValue(message?.reasoning) ||
    stringValue(message?.thinking) ||
    "";

  return { textChunk, reasoningChunk };
}

function splitSseFrames(buffer: string): string[] {
  return buffer.split(/\r?\n\r?\n/g);
}

function extractSseDataPayload(frame: string): string {
  return frame
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

function parseToolCommand(rawReply: string): { tool: string; arguments: Record<string, unknown> } | null {
  const cleaned = rawReply.trim().replace(/^```json\s*|\s*```$/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      tool?: string;
      arguments?: Record<string, unknown>;
    };
    if (!parsed.tool || typeof parsed.tool !== "string") {
      return null;
    }
    return {
      tool: parsed.tool,
      arguments: parsed.arguments ?? {}
    };
  } catch {
    return null;
  }
}

function executeTool(
  tool: string,
  args: Record<string, unknown>,
  playerId: string,
  context: AgentRoomContext,
  legalMovesAllowed: boolean
): ToolResult {
  if (context.isPaused()) {
    return {
      done: false,
      summary: "The game is paused.",
      aborted: true
    };
  }

  switch (tool) {
    case "get_state":
      return {
        done: false,
        summary: JSON.stringify(context.game.getSnapshot(playerId))
      };
    case "list_legal_moves": {
      if (!legalMovesAllowed) {
        return {
          done: false,
          summary: "The list_legal_moves tool is not allowed for this agent."
        };
      }
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 16)) : 8;
      const moves = context.game.listLegalMoves(playerId, limit);
      const simplified = moves.map(simplifyLegalMove);
      return {
        done: false,
        summary: JSON.stringify(simplified)
      };
    }
    case "play_move": {
      const placements = Array.isArray(args.placements) ? (args.placements as AgentPlacement[]) : [];
      const mapped = mapAgentPlacements(context.game, playerId, placements);
      if (!mapped.ok) {
        context.pushSystemChat("Invalid placement.");
        return {
          done: false,
          summary: describePlayMoveFailure(context.game, playerId, placements, mapped.error)
        };
      }
      const preview = context.game.previewMove(playerId, mapped.placements);
      if (preview.ok) {
        context.pushChat(playerId, `Try "${preview.word}" for ${preview.score} points.`);
      }
      const result = context.game.submitMove(playerId, mapped.placements);
      if (!result.ok) {
        context.pushSystemChat("Invalid placement.");
      }
      return {
        done: result.ok,
        summary: result.ok ? result.move.summary : describePlayMoveFailure(context.game, playerId, placements, result.error)
      };
    }
    case "exchange_tiles": {
      const letters = Array.isArray(args.letters) ? args.letters.map(String) : [];
      const mapped = mapLettersToTileIds(context.game, playerId, letters);
      if (!mapped.ok) {
        return { done: false, summary: mapped.error };
      }
      const result = context.game.exchangeTiles(playerId, mapped.tileIds);
      return {
        done: result.ok,
        summary: result.ok ? result.move.summary : result.error
      };
    }
    case "send_chat": {
      const message = String(args.message ?? "").trim();
      if (!message) {
        return { done: false, summary: "Empty message." };
      }
      context.pushChat(playerId, message);
      return { done: false, summary: "Message sent." };
    }
    case "pass_turn": {
      const result = context.game.pass(playerId);
      return {
        done: result.ok,
        summary: result.ok ? result.move.summary : result.error
      };
    }
    default:
      return { done: false, summary: `Unknown tool: ${tool}` };
  }
}

function simplifyLegalMove(move: LegalMove) {
  return {
    score: move.score,
    formedWords: move.formedWords,
    summary: move.summary,
    placements: move.placements.map((placement: PlacementInput) => ({
      row: placement.row,
      col: placement.col,
      letter: placement.letter ?? ""
    }))
  };
}

function mapAgentPlacements(
  game: ScrabbleGame,
  playerId: string,
  placements: AgentPlacement[]
): { ok: true; placements: PlacementInput[] } | { ok: false; error: string } {
  const player = game.getPlayer(playerId);
  if (!player) {
    return { ok: false, error: "Player not found." };
  }

  const board = game.getSnapshot(playerId).board;
  const pool = player.rack.map((tile: Tile) => ({ ...tile }));
  const mapped: PlacementInput[] = [];
  for (const [index, placement] of placements.entries()) {
    if (
      typeof placement !== "object" ||
      placement === null ||
      !Number.isInteger(placement.row) ||
      !Number.isInteger(placement.col)
    ) {
      return { ok: false, error: `Placement ${index + 1}: invalid coordinates. Expected format {row, col, letter}.` };
    }
    const normalizedLetter = String(placement.letter ?? "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toUpperCase()
      .slice(0, 1);
    if (!normalizedLetter) {
      return {
        ok: false,
        error: `Placement ${index + 1} (${formatCoord(placement.row, placement.col)}): missing letter.`
      };
    }

    const boardCell = board[placement.row]?.[placement.col];
    const existingLetter =
      boardCell?.tile ? (boardCell.tile.blank ? boardCell.tile.assignedLetter || "" : boardCell.tile.letter) : "";
    if (existingLetter) {
      if (existingLetter.toUpperCase() !== normalizedLetter) {
        return {
          ok: false,
          error: `Placement ${index + 1} (${formatCoord(placement.row, placement.col)}): square already contains ${existingLetter}.`
        };
      }
      continue;
    }

    const directIndex = pool.findIndex((tile: Tile) => !tile.blank && tile.letter === normalizedLetter);
    const blankIndex = pool.findIndex((tile: Tile) => tile.blank);
    const pickedIndex = directIndex >= 0 ? directIndex : blankIndex;
    if (pickedIndex === -1) {
      return {
        ok: false,
        error: `Placement ${index + 1} (${formatCoord(placement.row, placement.col)}): letter ${normalizedLetter} is not in rack ${formatRack(player.rack)}.`
      };
    }
    const tile = pool.splice(pickedIndex, 1)[0];
    mapped.push({
      row: placement.row,
      col: placement.col,
      tileId: tile.id,
      letter: tile.blank ? normalizedLetter : undefined
    });
  }

  if (mapped.length === 0) {
    return { ok: false, error: "No new tiles were provided. Return only newly placed tiles, or include at least one new tile." };
  }

  return { ok: true, placements: mapped };
}

function mapLettersToTileIds(
  game: ScrabbleGame,
  playerId: string,
  letters: string[]
): { ok: true; tileIds: string[] } | { ok: false; error: string } {
  const player = game.getPlayer(playerId);
  if (!player) {
    return { ok: false, error: "Player not found." };
  }
  const pool = player.rack.map((tile: Tile) => ({ ...tile }));
  const tileIds: string[] = [];
  for (const rawLetter of letters) {
    const letter = rawLetter.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().slice(0, 1);
    const index = pool.findIndex((tile: Tile) => (letter === "?" ? tile.blank : tile.letter === letter && !tile.blank));
    if (index === -1) {
      return { ok: false, error: `Letter not found in rack: ${letter}` };
    }
    tileIds.push(pool.splice(index, 1)[0].id);
  }
  return { ok: true, tileIds };
}

function runFallbackTurn(playerId: string, context: AgentRoomContext, legalMovesAllowed: boolean): ToolResult {
  if (context.isPaused()) {
    return { done: false, summary: "Turn interrupted by pause.", aborted: true };
  }

  const player = context.game.getPlayer(playerId);
  if (!player) {
    return { done: false, summary: "Agent not found." };
  }

  context.beginTrace({
    playerId,
    playerName: player.name,
    provider: player.agentConfig?.provider ?? "openai_compatible",
    model: player.agentConfig?.model ?? "fallback",
    updatedAt: Date.now(),
    systemPrompt: resolveAgentSystemPrompt(player.agentConfig?.systemPrompt, {
      allowLegalMoves: player.agentConfig?.allowLegalMoves
    }),
    turnCount: 0,
    fallbackCount: 0,
    events: []
  });

  const moves = context.game.listLegalMoves(playerId, 8);
  if (moves.length > 0) {
    const fallbackReason = legalMovesAllowed
      ? `The fallback engine chooses a strong available move: ${moves[0].summary}.`
      : "The fallback engine chooses a playable internal move without exposing the legal move list.";
    context.pushTraceEvent(playerId, createTraceEvent("reasoning", "Fallback engine", fallbackReason));
    if (Math.random() < 0.35) {
      context.pushChat(playerId, `Trying ${moves[0].formedWords[0]} for ${moves[0].score} points.`);
    }
    context.pushTraceEvent(
      playerId,
      createTraceEvent(
        "tool_call",
        "Tool call",
        JSON.stringify(
          {
            tool: "play_move",
            arguments: {
              placements: moves[0].placements.map((placement) => ({
                row: placement.row,
                col: placement.col,
                letter: placement.letter ?? ""
              }))
            }
          },
          null,
          2
        )
      )
    );
    const result = context.game.submitMove(playerId, moves[0].placements);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Result", result.ok ? result.move.summary : result.error));
    return {
      done: result.ok,
      summary: result.ok ? result.move.summary : result.error
    };
  }

  const exchangeCandidates = player.rack.slice(0, Math.min(3, player.rack.length)).map((tile: Tile) => tile.id);
  if (exchangeCandidates.length > 0) {
    context.pushTraceEvent(
      playerId,
      createTraceEvent(
        "reasoning",
        "Fallback engine",
        legalMovesAllowed
          ? "No satisfying move found. The agent attempts an exchange."
          : "No move selected. The fallback engine attempts an exchange."
      )
    );
    const result = context.game.exchangeTiles(playerId, exchangeCandidates);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Result", result.ok ? result.move.summary : result.error));
    if (result.ok) {
      return { done: true, summary: result.move.summary };
    }
  }

  const result = context.game.pass(playerId);
  context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Result", result.ok ? result.move.summary : result.error));
  return {
    done: result.ok,
    summary: result.ok ? result.move.summary : result.error
  };
}

function describePlayMoveFailure(
  game: ScrabbleGame,
  playerId: string,
  attemptedPlacements: AgentPlacement[],
  reason: string
): string {
  const player = game.getPlayer(playerId);
  const extraHints: string[] = [];
  if (reason.includes("already contains")) {
    extraHints.push("Hint: you probably returned a crossing letter that is already on the board. With play_move, return only newly placed tiles.");
  }
  const details = [
    `Reason: ${reason}`,
    `Attempted placements: ${formatAttemptedPlacements(attemptedPlacements)}`,
    `Current rack: ${player ? formatRack(player.rack) : "(player not found)"}`,
    "Reminder: the game is played in English.",
    "Reminder: tool coordinates are 0-indexed.",
    ...extraHints
  ];
  return `Move rejected.\n${details.join("\n")}`;
}

function formatAttemptedPlacements(placements: AgentPlacement[]): string {
  if (placements.length === 0) {
    return "(none)";
  }

  return placements
    .map((placement, index) => {
      const letter = String(placement.letter ?? "?").slice(0, 1) || "?";
      if (!Number.isInteger(placement.row) || !Number.isInteger(placement.col)) {
        return `#${index + 1} ${letter} invalid coordinates`;
      }
      return `#${index + 1} ${letter} at ${formatCoord(placement.row, placement.col)}`;
    })
    .join(", ");
}

function formatRack(rack: Tile[]): string {
  if (rack.length === 0) {
    return "[]";
  }
  return `[${rack.map((tile) => (tile.blank ? "?" : tile.letter)).join(", ")}]`;
}

function formatCoord(row: number, col: number): string {
  return `row ${row}, col ${col} (human display ${row + 1},${col + 1})`;
}

function createTraceEvent(kind: AgentTraceEvent["kind"], title: string, content: string): AgentTraceEvent {
  return {
    id: nanoid(),
    kind,
    title,
    content,
    createdAt: Date.now()
  };
}

function snapshotBoard(board: ReturnType<ScrabbleGame["getSnapshot"]>["board"]): string[][] {
  return board.map((row) => row.map((cell) => (cell.tile ? cell.tile.assignedLetter || cell.tile.letter : ".")));
}

function summarizeBoardDelta(
  previousBoard: string[][] | null,
  board: ReturnType<ScrabbleGame["getSnapshot"]>["board"]
): Array<{ row: number; col: number; letter: string }> {
  const currentBoard = snapshotBoard(board);
  const deltas: Array<{ row: number; col: number; letter: string }> = [];
  for (let row = 0; row < currentBoard.length; row += 1) {
    for (let col = 0; col < currentBoard[row].length; col += 1) {
      const previousLetter = previousBoard?.[row]?.[col] ?? ".";
      const currentLetter = currentBoard[row][col];
      if (currentLetter !== "." && currentLetter !== previousLetter) {
        deltas.push({ row, col, letter: currentLetter });
      }
    }
  }
  return deltas;
}

function formatTimelineDate(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString("fr-CA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

async function emitBufferedChunks(text: string, emit: (chunk: string) => void, signal: AbortSignal): Promise<void> {
  if (!text) {
    return;
  }
  const parts = text.match(/\S+\s*|\n/g) ?? [text];
  for (const part of parts) {
    throwIfAborted(signal);
    emit(part);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  }
  return signal;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function joinTextParts(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && "text" in entry) {
        return stringValue((entry as { text?: unknown }).text);
      }
      return "";
    })
    .join("");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return String(error).includes("AbortError") || String(error).includes("room_paused");
}

async function callStreamProviderWithRetries(
  provider: "openai_compatible" | "openrouter",
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  callbacks: ProviderCallbacks,
  diagnostics?: (type: string, payload: Record<string, unknown>) => void
): Promise<ProviderReply> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestSignal = withTimeout(signal, PROVIDER_TIMEOUT_MS);
    diagnostics?.("provider_request_started", {
      provider,
      url,
      model: String(body.model ?? ""),
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      attempt: attempt + 1
    });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: requestSignal,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new ProviderTransportError(`${provider} error ${response.status}`, isRetryableStatus(response.status));
      }

      diagnostics?.("provider_response_headers", {
        provider,
        contentType: response.headers.get("content-type") ?? null,
        status: response.status,
        attempt: attempt + 1
      });

      return await readProviderResponse(response, callbacks, requestSignal, diagnostics);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error;
      const retryable = isRetryableProviderError(error);
      diagnostics?.("provider_attempt_failed", {
        provider,
        attempt: attempt + 1,
        retryable,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!retryable || attempt === 2) {
        break;
      }
      await delay(350 * (attempt + 1), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderTransportError) {
    return error.retryable;
  }
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|socket hang up|network|fetch failed/i.test(message);
}

function isPossiblyUnsupportedRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(error 400|error 422|unsupported|unknown|invalid|extra inputs|unrecognized|unexpected)/i.test(message);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
