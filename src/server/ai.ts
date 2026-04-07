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
  getPublicTimeline: () => PublicTimelineEntry[];
  pushChat: (playerId: string, text: string) => ChatMessage;
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

export async function runAgentTurn(
  playerId: string,
  agentConfig: AgentConfig | undefined,
  context: AgentRoomContext
): Promise<ToolResult> {
  const player = context.game.getPlayer(playerId);
  if (!player) {
    return { done: false, summary: "Agent introuvable." };
  }
  if (!agentConfig) {
    return runFallbackTurn(playerId, context, false);
  }

  const systemPrompt = resolveAgentSystemPrompt(agentConfig.systemPrompt);
  const legalMovesAllowed = Boolean(agentConfig.allowLegalMoves);
  context.beginTrace({
    playerId,
    playerName: player.name,
    provider: agentConfig.provider,
    model: agentConfig.model,
    updatedAt: Date.now(),
    systemPrompt,
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
  context.pushTraceEvent(playerId, createTraceEvent("context", "Contexte", turnContext));
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
      const pausedResult = { done: false, summary: "Tour interrompu par pause.", aborted: true };
      context.pushTraceEvent(playerId, createTraceEvent("status", "Pause", pausedResult.summary));
      context.setAgentState(playerId, state);
      return pausedResult;
    }

    const reasoningEvent = createTraceEvent("reasoning", `Reasoning ${step + 1}`, "");
    const providerReplyEvent = createTraceEvent("provider_reply", `Réponse modèle ${step + 1}`, "");
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
      });
    } catch (error) {
      if (isAbortError(error)) {
        const pausedResult = { done: false, summary: "Tour interrompu par pause.", aborted: true };
        context.pushTraceEvent(playerId, createTraceEvent("status", "Pause", pausedResult.summary));
        context.setAgentState(playerId, state);
        return pausedResult;
      }
      context.setAgentState(playerId, state);
      context.pushTraceEvent(playerId, createTraceEvent("status", "Fallback", "Échec fournisseur. Passage sur le moteur de secours."));
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
      context.pushTraceEvent(playerId, createTraceEvent("provider_reply", `Réponse modèle ${step + 1}`, providerReply.text || "(vide)"));
    }

    conversation = [...conversation, { role: "assistant", content: providerReply.text || "(vide)" }];

    const command = parseToolCommand(providerReply.text);
    if (!command) {
      const reminder = [
        "Réponse invalide. Tu dois renvoyer un unique objet JSON {tool, arguments}.",
        "Le jeu se joue en français.",
        "Les coordonnées row/col sont 0-indexées."
      ].join("\n");
      context.pushTraceEvent(playerId, createTraceEvent("status", "Réponse invalide", providerReply.text || "(vide)"));
      conversation = [...conversation, { role: "user", content: reminder }];
      state = { ...state, messages: conversation };
      context.setAgentState(playerId, state);
      continue;
    }

    context.pushTraceEvent(playerId, createTraceEvent("tool_call", `Tool call ${step + 1}`, JSON.stringify(command, null, 2)));
    const result = executeTool(command.tool, command.arguments, playerId, context, legalMovesAllowed);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", `Résultat ${step + 1}`, result.summary));

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
      `Résultat outil: ${result.summary}`,
      `Chevalet actuel: ${updatedPlayer ? formatRack(updatedPlayer.rack) : "(joueur introuvable)"}`,
      "Rappel: le jeu se joue en français.",
      "Rappel: toutes les coordonnées row/col des outils sont 0-indexées."
    ].join("\n");
    conversation = [...conversation, { role: "user", content: retryMessage }];
    state = { ...state, messages: conversation };
    context.setAgentState(playerId, state);
  }

  context.setAgentState(playerId, state);
  context.pushTraceEvent(playerId, createTraceEvent("status", "Fallback", "Aucune action finale valide. Passage sur le moteur de secours."));
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
        language: "fr",
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
      instruction: "À toi de jouer. Réponds uniquement avec un outil JSON."
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
      instruction: "C'est à toi. Choisis une action finale légale via un outil JSON."
    },
    null,
    2
  );
}

async function callProvider(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks
): Promise<ProviderReply> {
  switch (config.provider) {
    case "openai_compatible":
      return callOpenAICompatible(config, messages, signal, callbacks);
    case "openrouter":
      return callOpenRouter(config, messages, signal, callbacks);
    case "google":
      return callGoogle(config, messages, signal, callbacks);
    case "ollama":
      return callOllama(config, messages, signal, callbacks);
    default:
      throw new Error("Unsupported provider");
  }
}

async function callOpenAICompatible(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks
): Promise<ProviderReply> {
  const baseUrl = config.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || "http://127.0.0.1:1234/v1/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0.2,
      stream: true,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible error ${response.status}`);
  }

  return readSseResponse(response, callbacks);
}

async function callOpenRouter(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks
): Promise<ProviderReply> {
  const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const response = await fetch(config.baseUrl || "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0.2,
      stream: true,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error ${response.status}`);
  }

  return readSseResponse(response, callbacks);
}

async function callGoogle(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks
): Promise<ProviderReply> {
  const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY");
  }

  const model = config.model || "gemini-2.5-flash";
  const [systemMessage, ...restMessages] = messages;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemMessage?.content ?? "" }]
        },
        contents: restMessages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        })),
        generationConfig: {
          temperature: config.temperature ?? 0.2
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Google AI error ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  await emitBufferedChunks(text, callbacks.onTextChunk, signal);
  return { text };
}

async function callOllama(
  config: AgentConfig,
  messages: ConversationMessage[],
  signal: AbortSignal,
  callbacks: ProviderCallbacks
): Promise<ProviderReply> {
  const response = await fetch(config.baseUrl || "http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      stream: true,
      options: {
        temperature: config.temperature ?? 0.2
      },
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}`);
  }

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
    throwIfAborted(signal);
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

  return { text, reasoning };
}

async function readSseResponse(response: Response, callbacks: ProviderCallbacks): Promise<ProviderReply> {
  if (!response.body) {
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
    return { text, reasoning };
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
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        const data = JSON.parse(payload) as Record<string, unknown>;
        const { textChunk, reasoningChunk } = extractSseChunks(data);
        if (reasoningChunk) {
          reasoning += reasoningChunk;
          callbacks.onReasoningChunk(reasoningChunk);
        }
        if (textChunk) {
          text += textChunk;
          callbacks.onTextChunk(textChunk);
        }
      }
    }
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
      summary: "La partie est en pause.",
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
          summary: "L'outil list_legal_moves n'est pas autorisé pour cet agent."
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
        return {
          done: false,
          summary: describePlayMoveFailure(context.game, playerId, placements, mapped.error)
        };
      }
      const result = context.game.submitMove(playerId, mapped.placements);
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
        return { done: false, summary: "Message vide." };
      }
      context.pushChat(playerId, message);
      return { done: false, summary: "Message envoyé." };
    }
    case "pass_turn": {
      const result = context.game.pass(playerId);
      return {
        done: result.ok,
        summary: result.ok ? result.move.summary : result.error
      };
    }
    default:
      return { done: false, summary: `Outil inconnu: ${tool}` };
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
    return { ok: false, error: "Joueur introuvable." };
  }

  const pool = player.rack.map((tile: Tile) => ({ ...tile }));
  const mapped: PlacementInput[] = [];
  for (const [index, placement] of placements.entries()) {
    if (
      typeof placement !== "object" ||
      placement === null ||
      !Number.isInteger(placement.row) ||
      !Number.isInteger(placement.col)
    ) {
      return { ok: false, error: `Placement ${index + 1}: coordonnées invalides. Format attendu {row, col, letter}.` };
    }
    const normalizedLetter = String(placement.letter ?? "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toUpperCase()
      .slice(0, 1);
    if (!normalizedLetter) {
      return {
        ok: false,
        error: `Placement ${index + 1} (${formatCoord(placement.row, placement.col)}): lettre manquante.`
      };
    }
    const directIndex = pool.findIndex((tile: Tile) => !tile.blank && tile.letter === normalizedLetter);
    const blankIndex = pool.findIndex((tile: Tile) => tile.blank);
    const pickedIndex = directIndex >= 0 ? directIndex : blankIndex;
    if (pickedIndex === -1) {
      return {
        ok: false,
        error: `Placement ${index + 1} (${formatCoord(placement.row, placement.col)}): lettre ${normalizedLetter} absente du chevalet ${formatRack(player.rack)}.`
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

  return { ok: true, placements: mapped };
}

function mapLettersToTileIds(
  game: ScrabbleGame,
  playerId: string,
  letters: string[]
): { ok: true; tileIds: string[] } | { ok: false; error: string } {
  const player = game.getPlayer(playerId);
  if (!player) {
    return { ok: false, error: "Joueur introuvable." };
  }
  const pool = player.rack.map((tile: Tile) => ({ ...tile }));
  const tileIds: string[] = [];
  for (const rawLetter of letters) {
    const letter = rawLetter.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().slice(0, 1);
    const index = pool.findIndex((tile: Tile) => (letter === "?" ? tile.blank : tile.letter === letter && !tile.blank));
    if (index === -1) {
      return { ok: false, error: `Lettre introuvable dans le chevalet: ${letter}` };
    }
    tileIds.push(pool.splice(index, 1)[0].id);
  }
  return { ok: true, tileIds };
}

function runFallbackTurn(playerId: string, context: AgentRoomContext, legalMovesAllowed: boolean): ToolResult {
  if (context.isPaused()) {
    return { done: false, summary: "Tour interrompu par pause.", aborted: true };
  }

  const player = context.game.getPlayer(playerId);
  if (!player) {
    return { done: false, summary: "Agent introuvable." };
  }

  context.beginTrace({
    playerId,
    playerName: player.name,
    provider: player.agentConfig?.provider ?? "openai_compatible",
    model: player.agentConfig?.model ?? "fallback",
    updatedAt: Date.now(),
    systemPrompt: resolveAgentSystemPrompt(player.agentConfig?.systemPrompt),
    events: []
  });

  const moves = context.game.listLegalMoves(playerId, 8);
  if (moves.length > 0) {
    const fallbackReason = legalMovesAllowed
      ? `Le moteur de secours choisit un bon coup disponible: ${moves[0].summary}.`
      : "Le moteur de secours choisit un coup jouable en interne sans exposer la liste des coups possibles.";
    context.pushTraceEvent(playerId, createTraceEvent("reasoning", "Moteur de secours", fallbackReason));
    if (Math.random() < 0.35) {
      context.pushChat(playerId, `Je tente ${moves[0].formedWords[0]} pour ${moves[0].score} points.`);
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
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Résultat", result.ok ? result.move.summary : result.error));
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
        "Moteur de secours",
        legalMovesAllowed
          ? "Aucun coup satisfaisant trouvé. L'agent tente un échange."
          : "Aucun coup retenu. Le moteur de secours tente un échange."
      )
    );
    const result = context.game.exchangeTiles(playerId, exchangeCandidates);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Résultat", result.ok ? result.move.summary : result.error));
    if (result.ok) {
      return { done: true, summary: result.move.summary };
    }
  }

  const result = context.game.pass(playerId);
  context.pushTraceEvent(playerId, createTraceEvent("tool_result", "Résultat", result.ok ? result.move.summary : result.error));
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
  const details = [
    `Raison: ${reason}`,
    `Placements tentés: ${formatAttemptedPlacements(attemptedPlacements)}`,
    `Chevalet actuel: ${player ? formatRack(player.rack) : "(joueur introuvable)"}`,
    "Rappel: le jeu se joue en français.",
    "Rappel: les coordonnées des outils sont 0-indexées."
  ];
  return `Coup refusé.\n${details.join("\n")}`;
}

function formatAttemptedPlacements(placements: AgentPlacement[]): string {
  if (placements.length === 0) {
    return "(aucun)";
  }

  return placements
    .map((placement, index) => {
      const letter = String(placement.letter ?? "?").slice(0, 1) || "?";
      if (!Number.isInteger(placement.row) || !Number.isInteger(placement.col)) {
        return `#${index + 1} ${letter} coordonnées invalides`;
      }
      return `#${index + 1} ${letter} en ${formatCoord(placement.row, placement.col)}`;
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
  return `row ${row}, col ${col} (affichage humain ${row + 1},${col + 1})`;
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
