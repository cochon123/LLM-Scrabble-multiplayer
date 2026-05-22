import type { ConversationMode, RoomView } from "../../shared/types";
import type { ConversationItem } from "../lib/types";
import { modeLabel } from "../lib/helpers";
import { ChatRow, ConversationTraceCard } from "./shared";

export function ConversationPanel({
  view,
  mode,
  onCycleMode,
  onPause,
  isHost,
  feedRef,
  items,
  expandedConversationId,
  onToggleConversationItem,
  chatDraft,
  setChatDraft,
  onSendChat
}: {
  view: RoomView;
  mode: ConversationMode;
  onCycleMode: () => void;
  onPause: () => void;
  isHost: boolean;
  feedRef: React.RefObject<HTMLDivElement | null>;
  items: ConversationItem[];
  expandedConversationId: string | null;
  onToggleConversationItem: (id: string) => void;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  onSendChat: () => void;
}) {
  return (
    <aside className="min-w-0 flex min-h-0 flex-col overflow-hidden rounded-xl bg-white dark:bg-slate-950 p-4 shadow-xl shadow-slate-200/80 dark:shadow-slate-950/70 dark:ring-1 dark:ring-white/6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Conversation</p>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Chat</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-xl bg-slate-100 dark:bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 dark:ring-1 dark:ring-white/8" onClick={onCycleMode}>
            Mode: {modeLabel(mode)}
          </button>
          <button
            className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            onClick={onPause}
            disabled={!isHost || view.status === "lobby" || view.game.finished}
          >
            {view.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div ref={feedRef} className="min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl bg-slate-100 dark:bg-slate-900 p-3">
        <div className="grid gap-3">
          {items.map((item) =>
            item.type === "chat" ? (
              <ChatRow
                key={item.id}
                message={item.message}
                seat={view.game.players.find((player) => player.id === item.message.authorId)}
                trace={view.agentTraces.find((trace) => trace.playerId === item.message.authorId)}
              />
            ) : (
              <ConversationTraceCard
                key={item.id}
                trace={item.trace}
                event={item.event}
                mode={mode}
                expanded={expandedConversationId === item.id}
                rack={view.game.players.find((player) => player.id === item.trace.playerId)?.rack}
                onToggle={() => onToggleConversationItem(item.id)}
              />
            )
          )}
          {items.length === 0 ? <div className="rounded-lg bg-white dark:bg-slate-950 px-4 py-3 text-sm text-slate-500 dark:text-slate-400">No messages yet.</div> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <input
          className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-slate-900 dark:text-white outline-none transition focus:border-indigo-500 dark:placeholder:text-slate-500"
          value={chatDraft}
          onChange={(event) => setChatDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSendChat();
            }
          }}
          placeholder="Write a message"
        />
        <button className="rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500 transition" onClick={onSendChat}>
          Send
        </button>
      </div>
    </aside>
  );
}
