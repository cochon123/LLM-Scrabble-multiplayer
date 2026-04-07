import { nanoid } from "nanoid";
import { resolveAgentSystemPrompt } from "../shared/agent-prompt.js";
import { ScrabbleGame } from "../shared/game.js";
import type { AgentConfig, AgentTrace, AgentTraceEvent, ChatMessage, LegalMove, PlacementInput, Tile, TurnLog } from "../shared/types.js";

interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AgentRoomContext {
  game: ScrabbleGame;
  roomId: string;
  recentChat: ChatMessage[];
  logs: TurnLog[];
  pushChat: (playerId: string, text: string) => ChatMessage;
  beginTrace: (trace: AgentTrace) => void;
  pushTraceEvent: (playerId: string, event: AgentTraceEvent) => void;
  getConversation: (playerId: string) => ConversationMessage[];
  setConversation: (playerId: string, messages: ConversationMessage[]) => void;
}

interface ToolResult {
  done: boolean;
  summary: string;
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

  const toolHistory: Array<{ command: string; result: unknown }> = [];
  const systemPrompt = resolveAgentSystemPrompt(agentConfig.systemPrompt);
  const legalMovesAllowed = Boolean(agentConfig.allowLegalMoves);
  const toolPrompt = [
    "Outils disponibles:",
    "get_state {}",
    ...(legalMovesAllowed ? ['list_legal_moves {"limit": number}'] : []),
    'play_move {"placements":[{"row":number,"col":number,"letter":"A"}]}',
    'exchange_tiles {"letters":["A","E"]}',
    'send_chat {"message":"..."}',
    "pass_turn {}"
  ].join("\n");
  context.beginTrace({
    playerId,
    playerName: player.name,
    provider: agentConfig.provider,
    model: agentConfig.model,
    updatedAt: Date.now(),
    systemPrompt,
    events: [
      createTraceEvent("prompt", "System prompt", `${systemPrompt}\n${toolPrompt}`)
    ]
  });

  let conversation = context.getConversation(playerId);
  const fullSystemPrompt = `${systemPrompt}\n${toolPrompt}`;
  if (conversation.length === 0 || conversation[0]?.role !== "system" || conversation[0]?.content !== fullSystemPrompt) {
    conversation = [{ role: "system", content: fullSystemPrompt }];
  }

  for (let step = 0; step < 6; step += 1) {
    const transcript = buildTranscript(context, playerId, toolHistory, step === 0, conversation.length - 1);
    context.pushTraceEvent(playerId, createTraceEvent("context", `Contexte ${step + 1}`, transcript));
    conversation = [...conversation, { role: "user", content: transcript }];
    let providerReply: ProviderReply;
    try {
      providerReply = await callProvider(agentConfig, conversation);
    } catch {
      context.setConversation(playerId, conversation);
      context.pushTraceEvent(playerId, createTraceEvent("status", "Fallback", "Echec fournisseur. Passage sur le moteur de secours."));
      return runFallbackTurn(playerId, context, legalMovesAllowed);
    }

    if (providerReply.reasoning?.trim()) {
      context.pushTraceEvent(playerId, createTraceEvent("reasoning", `Reasoning ${step + 1}`, providerReply.reasoning));
    }
    context.pushTraceEvent(playerId, createTraceEvent("provider_reply", `Réponse modèle ${step + 1}`, providerReply.text || "(vide)"));
    conversation = [...conversation, { role: "assistant", content: providerReply.text || "(vide)" }];

    const command = parseToolCommand(providerReply.text);
    if (!command) {
      toolHistory.push({
        command: providerReply.text,
        result: { error: "Réponse invalide. Un objet JSON unique était attendu." }
      });
      context.pushTraceEvent(playerId, createTraceEvent("status", "Réponse invalide", providerReply.text || "(vide)"));
      conversation = [
        ...conversation,
        {
          role: "user",
          content: "Réponse invalide. Tu dois renvoyer un unique objet JSON {tool, arguments}."
        }
      ];
      continue;
    }

    context.pushTraceEvent(playerId, createTraceEvent("tool_call", `Tool call ${step + 1}`, JSON.stringify(command, null, 2)));
    const result = executeTool(command.tool, command.arguments, playerId, context, legalMovesAllowed);
    context.pushTraceEvent(playerId, createTraceEvent("tool_result", `Résultat ${step + 1}`, result.summary));
    toolHistory.push({ command: JSON.stringify(command), result });
    conversation = [
      ...conversation,
      {
        role: "user",
        content: `Résultat outil: ${result.summary}`
      }
    ];
    context.setConversation(playerId, conversation);
    if (result.done) {
      return result;
    }
  }

  context.setConversation(playerId, conversation);
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

function buildTranscript(
  context: AgentRoomContext,
  playerId: string,
  toolHistory: Array<{ command: string; result: unknown }>,
  firstTurn: boolean,
  priorConversationTurns: number
): string {
  const player = context.game.getPlayer(playerId);
  const snapshot = context.game.getSnapshot(playerId);
  const board = snapshot.board
    .map((row: (typeof snapshot.board)[number]) =>
      row
        .map((cell: (typeof snapshot.board)[number][number]) => (cell.tile ? cell.tile.assignedLetter || cell.tile.letter : "."))
        .join(" ")
    )
    .join("\n");

  const payload = {
    roomId: context.roomId,
    me: {
      id: player?.id,
      name: player?.name,
      rack: player?.rack.map((tile: Tile) => (tile.blank ? "?" : tile.letter)) ?? []
    },
    turn: snapshot.turn,
    bagCount: snapshot.bagCount,
    currentPlayerId: snapshot.currentPlayerId,
    players: snapshot.players.map((seat) => ({
      id: seat.id,
      name: seat.name,
      score: seat.score,
      rackCount: seat.rackCount
    })),
    board,
    lastMove: snapshot.lastMove,
    recentChat: context.recentChat.slice(-8).map((message) => ({
      author: message.authorName,
      text: message.text
    })),
    logs: context.logs.slice(-8).map((log) => `${log.playerName}: ${log.summary}`)
  };

  return [
    "Contexte:",
    "Rappel: jeu en français. Toutes les coordonnées row/col utilisées par les outils sont 0-indexées. La case centrale est row 7, col 7.",
    `Historique conversation deja accumule: ${priorConversationTurns} message(s).`,
    JSON.stringify(payload, null, 2),
    "Historique outils:",
    JSON.stringify(toolHistory, null, 2)
  ].join("\n\n");
}

async function callProvider(config: AgentConfig, messages: ConversationMessage[]): Promise<ProviderReply> {
  switch (config.provider) {
    case "openai_compatible":
      return callOpenAICompatible(config, messages);
    case "openrouter":
      return callOpenRouter(config, messages);
    case "google":
      return callGoogle(config, messages);
    case "ollama":
      return callOllama(config, messages);
    default:
      throw new Error("Unsupported provider");
  }
}

async function callOpenAICompatible(config: AgentConfig, messages: ConversationMessage[]): Promise<ProviderReply> {
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
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0.2,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible error ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    reasoning: data.choices?.[0]?.message?.reasoning
  };
}

async function callOpenRouter(config: AgentConfig, messages: ConversationMessage[]): Promise<ProviderReply> {
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
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0.2,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    reasoning: data.choices?.[0]?.message?.reasoning
  };
}

async function callGoogle(config: AgentConfig, messages: ConversationMessage[]): Promise<ProviderReply> {
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

  return {
    text: data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""
  };
}

async function callOllama(config: AgentConfig, messages: ConversationMessage[]): Promise<ProviderReply> {
  const response = await fetch(config.baseUrl || "http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      options: {
        temperature: config.temperature ?? 0.2
      },
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}`);
  }

  const data = (await response.json()) as {
    message?: {
      content?: string;
      thinking?: string;
    };
  };

  return {
    text: data.message?.content ?? "",
    reasoning: data.message?.thinking
  };
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
  const player = context.game.getPlayer(playerId);
  if (!player) {
    return { done: false, summary: "Agent introuvable." };
  }

  const existingTrace = {
    playerId,
    playerName: player.name,
    provider: player.agentConfig?.provider ?? "openai_compatible",
    model: player.agentConfig?.model ?? "fallback",
    updatedAt: Date.now(),
    systemPrompt: resolveAgentSystemPrompt(player.agentConfig?.systemPrompt),
    events: [createTraceEvent("prompt", "System prompt", resolveAgentSystemPrompt(player.agentConfig?.systemPrompt))]
  } satisfies AgentTrace;
  context.beginTrace(existingTrace);

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
