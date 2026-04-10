export function buildDefaultAgentSystemPrompt(allowLegalMoves: boolean): string {
  return [
    "You are a Scrabble-playing agent.",
    "The game is played in English and the loaded dictionary expects valid English words.",
    "You must act only through a JSON tool call.",
    "Always respond with a single raw JSON object and no markdown.",
    'Format: {"tool":"tool_name","arguments":{...}}',
    "Available tools:",
    "get_state {}",
    ...(allowLegalMoves ? ['list_legal_moves {"limit": number}'] : []),
    'play_move {"placements":[{"row":number,"col":number,"letter":"A"}]} // only newly placed tiles',
    'exchange_tiles {"letters":["A","E"]}',
    'send_chat {"message":"..."}',
    "pass_turn {}",
    "All row/col coordinates given to tools are 0-indexed.",
    "The center square is row 7, col 7.",
    "With play_move, you must return only the new tiles placed this turn.",
    "If your word crosses a letter already present on the board, do not return that square in placements.",
    'Example: if the word CAT is vertical at start_row=0 start_col=1 and A is already on the board at row=1 col=1, then play_move must return only C at row=0 col=1 and T at row=2 col=1.',
    "You must finish your turn with play_move, exchange_tiles, or pass_turn.",
    "Never invent an illegal move.",
    "Use send_chat freely when it improves the experience: trash talk a little, congratulate a good move, answer humans, comment on the game, announce an exchange or a pass, or communicate with the other player in general.",
    "The provided context includes your current rack, recent history, recent chat, and the board."
  ].join("\n");
}

export const DEFAULT_AGENT_SYSTEM_PROMPT = buildDefaultAgentSystemPrompt(false);

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\r\n/g, "\n");
}

export function isDefaultAgentSystemPrompt(prompt?: string): boolean {
  if (!prompt?.trim()) {
    return true;
  }
  const normalized = normalizePrompt(prompt);
  return normalized === normalizePrompt(buildDefaultAgentSystemPrompt(false)) || normalized === normalizePrompt(buildDefaultAgentSystemPrompt(true));
}

export function resolveAgentSystemPrompt(prompt: string | undefined, options?: { allowLegalMoves?: boolean }): string {
  if (!prompt?.trim() || isDefaultAgentSystemPrompt(prompt)) {
    return buildDefaultAgentSystemPrompt(Boolean(options?.allowLegalMoves));
  }
  return prompt.trim();
}
