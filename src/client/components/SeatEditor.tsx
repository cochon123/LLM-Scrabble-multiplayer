import { useEffect, useState } from "react";
import { buildDefaultAgentSystemPrompt, isDefaultAgentSystemPrompt } from "../../shared/agent_prompt";
import type { AgentConfig, AgentProvider, AuthUserView, PlayerSeat } from "../../shared/types";
import { defaultBaseUrlForProvider } from "../lib/helpers";
import { ModelLogo } from "./shared";

export function SeatEditor({
  seat,
  disabled,
  defaultApiKeys,
  onSaveDefaultApiKey,
  onChange
}: {
  seat: PlayerSeat;
  disabled: boolean;
  defaultApiKeys: AuthUserView["defaultApiKeys"];
  onSaveDefaultApiKey: (provider: AgentProvider, apiKey: string) => void;
  onChange: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
}) {
  const defaultPromptForSeat = buildDefaultAgentSystemPrompt(Boolean(seat.agentConfig?.allowLegalMoves));
  const [draftName, setDraftName] = useState(seat.name);
  const [draftModel, setDraftModel] = useState(seat.agentConfig?.model ?? "local-model");
  const [draftBaseUrl, setDraftBaseUrl] = useState(seat.agentConfig?.baseUrl ?? "");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftApiKeyDirty, setDraftApiKeyDirty] = useState(false);
  const [draftSystemPrompt, setDraftSystemPrompt] = useState(seat.agentConfig?.systemPrompt ?? defaultPromptForSeat);
  const agentConfig = seat.agentConfig ?? {
    provider: "openai_compatible",
    model: "local-model",
    baseUrl: defaultBaseUrlForProvider("openai_compatible"),
    systemPrompt: defaultPromptForSeat,
    allowLegalMoves: false
  };

  useEffect(() => {
    setDraftName(seat.name);
    setDraftModel(seat.agentConfig?.model ?? "local-model");
    setDraftBaseUrl(seat.agentConfig?.baseUrl ?? "");
    setDraftApiKey("");
    setDraftApiKeyDirty(false);
    setDraftSystemPrompt(seat.agentConfig?.systemPrompt ?? defaultPromptForSeat);
  }, [defaultPromptForSeat, seat.id, seat.name, seat.agentConfig?.provider, seat.agentConfig?.model, seat.agentConfig?.baseUrl, seat.agentConfig?.systemPrompt, seat.agentConfig?.useSavedApiKey, seat.agentConfig?.hasCustomApiKey]);

  const [showPicker, setShowPicker] = useState(false);

  if (!seat.enabled) {
    return (
      <div className="relative">
        <button
          className="flex h-full min-h-[80px] w-full items-center justify-center rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/70 text-slate-400 hover:border-indigo-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition"
          disabled={disabled}
          onClick={() => { if (!disabled) setShowPicker(true); }}
        >
          <span className="text-3xl font-light">+</span>
        </button>
        {showPicker ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-white/95 dark:bg-slate-900/95 shadow-lg">
            <div className="flex flex-col gap-3 p-4">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 text-center">Add player</p>
              <div className="flex gap-3">
                <button
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                  onClick={() => { setShowPicker(false); onChange(seat, { enabled: true, kind: "human", name: `Player ${seat.seatIndex + 1}` }); }}
                >
                  Human
                </button>
                <button
                  className="rounded-xl bg-slate-700 dark:bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 dark:hover:bg-slate-500"
                  onClick={() => { setShowPicker(false); onChange(seat, { enabled: true, kind: "agent", name: `Agent ${seat.seatIndex + 1}`, agentConfig: { ...agentConfig, systemPrompt: defaultPromptForSeat } }); }}
                >
                  AI
                </button>
              </div>
              <button className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" onClick={() => setShowPicker(false)}>Cancel</button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`grid gap-3 rounded-xl border p-4 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 overflow-hidden`}>
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          <ModelLogo seat={seat} size="lg" />
        </div>
        <input
          className="min-w-0 flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-900 dark:text-white"
          value={draftName}
          disabled={disabled}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => {
            if (draftName !== seat.name) {
              onChange(seat, { name: draftName });
            }
          }}
        />
        <button
          className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 dark:hover:text-red-400 transition"
          disabled={disabled}
          onClick={() => { if (!disabled) onChange(seat, { enabled: false, kind: seat.kind, name: seat.name }); }}
          title="Remove player"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {seat.kind === "agent" ? (
        <>
          <div className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className="w-20 shrink-0">Provider</span>
            <select
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
              value={agentConfig.provider}
              disabled={disabled}
              onChange={(event) => {
                const nextProvider = event.target.value as AgentConfig["provider"];
                const nextBaseUrl = defaultBaseUrlForProvider(nextProvider);
                const nextUseSavedApiKey = Boolean(defaultApiKeys[nextProvider]);
                setDraftBaseUrl(nextBaseUrl);
                setDraftApiKey("");
                setDraftApiKeyDirty(false);
                onChange(seat, {
                  agentConfig: {
                    ...agentConfig,
                    provider: nextProvider,
                    baseUrl: nextBaseUrl,
                    apiKey: undefined,
                    useSavedApiKey: nextUseSavedApiKey,
                    hasCustomApiKey: false,
                    systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat
                  }
                });
              }}
            >
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="openrouter">OpenRouter</option>
              <option value="google">Google AI</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          <div className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className="w-20 shrink-0">Model</span>
            <input
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
              value={draftModel}
              disabled={disabled}
              onChange={(event) => setDraftModel(event.target.value)}
              onBlur={() => {
                if (draftModel !== agentConfig.model) {
                  onChange(seat, { agentConfig: { ...agentConfig, model: draftModel, systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat } });
                }
              }}
            />
          </div>

          <div className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className="w-20 shrink-0">Base URL</span>
            <input
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
              value={draftBaseUrl}
              disabled={disabled}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              onBlur={() => {
                if (draftBaseUrl !== (agentConfig.baseUrl ?? "")) {
                  onChange(seat, { agentConfig: { ...agentConfig, baseUrl: draftBaseUrl, systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat } });
                }
              }}
            />
          </div>

          <div className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className="w-20 shrink-0">API key</span>
            <input
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
              value={draftApiKey}
              disabled={disabled}
              placeholder={
                agentConfig.useSavedApiKey
                  ? "Default used"
                  : agentConfig.hasCustomApiKey
                    ? "Custom key saved"
                    : "Enter API key"
              }
              onChange={(event) => {
                setDraftApiKey(event.target.value);
                setDraftApiKeyDirty(true);
              }}
              onBlur={() => {
                if (!draftApiKeyDirty) {
                  return;
                }
                const nextApiKey = draftApiKey.trim();
                const nextUseSavedApiKey = !nextApiKey && Boolean(defaultApiKeys[agentConfig.provider]);
                onChange(seat, {
                  agentConfig: {
                    ...agentConfig,
                    apiKey: nextApiKey || undefined,
                    useSavedApiKey: nextUseSavedApiKey,
                    hasCustomApiKey: Boolean(nextApiKey),
                    systemPrompt: agentConfig.systemPrompt ?? defaultPromptForSeat
                  }
                });
                if (nextApiKey && window.confirm(`Use this API key as the default for ${agentConfig.provider}?`)) {
                  onSaveDefaultApiKey(agentConfig.provider, nextApiKey);
                }
                setDraftApiKey("");
                setDraftApiKeyDirty(false);
              }}
            />
          </div>

          <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 dark:border-slate-600 text-indigo-600"
              checked={Boolean(agentConfig.allowLegalMoves)}
              disabled={disabled}
              onChange={(event) => {
                const nextAllowLegalMoves = event.target.checked;
                const nextDefaultPrompt = buildDefaultAgentSystemPrompt(nextAllowLegalMoves);
                const nextSystemPrompt =
                  isDefaultAgentSystemPrompt(agentConfig.systemPrompt) ? nextDefaultPrompt : agentConfig.systemPrompt ?? nextDefaultPrompt;
                setDraftSystemPrompt(nextSystemPrompt);
                onChange(seat, {
                  agentConfig: { ...agentConfig, allowLegalMoves: nextAllowLegalMoves, systemPrompt: nextSystemPrompt }
                });
              }}
            />
            Allow this agent to request legal moves
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            System prompt
            <textarea
              className="min-h-[120px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3"
              value={draftSystemPrompt}
              disabled={disabled}
              onChange={(event) => setDraftSystemPrompt(event.target.value)}
              onBlur={() => {
                if (draftSystemPrompt !== (agentConfig.systemPrompt ?? defaultPromptForSeat)) {
                  onChange(seat, { agentConfig: { ...agentConfig, systemPrompt: draftSystemPrompt } });
                }
              }}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}
