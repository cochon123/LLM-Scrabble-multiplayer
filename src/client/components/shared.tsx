import type { PlayerSeat, RoomSummary, AgentTrace, ChatMessage, AgentProvider, AgentTraceEvent, ConversationMode, Tile, LegalMove } from "../../shared/types";
import { getModelLogo, roomStatusLabel, roomStatusBadge, traceEventClasses } from "../lib/helpers";

export function InlineError({ message }: { message: string }) {
  return <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-400">{message}</div>;
}

export function ModelLogo({
  seat,
  trace,
  name,
  size,
  borderless = false
}: {
  seat?: Pick<PlayerSeat, "name" | "kind" | "agentConfig"> | Pick<RoomSummary["seatSummaries"][number], "name" | "kind">;
  trace?: Pick<AgentTrace, "playerName" | "provider" | "model">;
  name?: string;
  size: "sm" | "lg";
  borderless?: boolean;
}) {
  const kind = seat?.kind;
  const agentCfg = seat && "agentConfig" in seat ? seat.agentConfig : undefined;
  const model = agentCfg?.model ?? trace?.model;
  const provider = agentCfg?.provider ?? trace?.provider;
  const resolvedName = seat?.name ?? trace?.playerName ?? name ?? "Agent";
  const className = `${size === "lg" ? "h-12 w-12" : "h-10 w-10"} rounded-xl bg-white p-1 object-contain shadow-sm ${borderless ? "" : "border border-slate-200 dark:border-slate-300"}`;
  if (resolvedName.trim().toLowerCase() === "system") {
    return <img src="/logos/system.png" alt="System" className={className} />;
  }
  if (kind === "human") {
    return (
      <div className={`${className} flex items-center justify-center`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-full w-full text-slate-700">
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path
            d="M6 20c0-3.3137 2.6863-6 6-6s6 2.6863 6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }
  const src = getModelLogo({ model, provider, name: resolvedName });
  return <img src={src} alt={resolvedName} className={className} />;
}

export function SmallRack({ rack }: { rack: Tile[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {rack.map((tile) => (
        <div key={tile.id} className="flex h-9 w-9 flex-col items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm">
          <span className="text-xs font-bold leading-none">{tile.blank ? tile.assignedLetter || "?" : tile.letter}</span>
          <span className="text-[8px] leading-none">{tile.value}</span>
        </div>
      ))}
    </div>
  );
}

export function LeaderboardCard({ player }: { player: PlayerSeat }) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        player.isCurrentTurn ? "border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20" : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ModelLogo seat={player} size="lg" />
          <div>
            <p className="font-bold text-slate-900 dark:text-white">{player.name}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{player.kind === "agent" ? "Agent" : "Human"}</p>
          </div>
        </div>
        <p className="text-3xl font-black text-slate-900 dark:text-white">{player.score}</p>
      </div>
    </div>
  );
}

export function RoomCard({
  room,
  onWatch,
  onJoin,
  onDelete
}: {
  room: RoomSummary;
  onWatch: () => void;
  onJoin: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  return (
    <div className="grid gap-4 rounded-xl bg-slate-50 dark:bg-slate-950 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Room</p>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white">{room.roomId}</h3>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${roomStatusBadge(room.status)}`}>{roomStatusLabel(room.status)}</span>
      </div>
      <div className="grid gap-2">
        {room.seatSummaries.filter((seat) => seat.enabled).map((seat) => (
          <div key={seat.id} className="flex items-center justify-between rounded-xl bg-white dark:bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-3">
              <ModelLogo seat={seat} size="sm" />
              <div>
                <p className="font-semibold text-slate-900 dark:text-white">{seat.name}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">{seat.kind === "agent" ? "Agent" : "Human"}</p>
              </div>
            </div>
            <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">{seat.score}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
        <span>{room.spectatorCount} spectator(s)</span>
        <span>{room.currentTurnPlayerName ? `To ${room.currentTurnPlayerName}` : "Waiting"}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500" onClick={onWatch}>
          Watch
        </button>
        {onDelete ? (
          <button className="rounded-xl bg-red-100 dark:bg-red-900/30 px-4 py-3 font-semibold text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        {onJoin ? (
          <button className="rounded-xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onJoin}>
            Join
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LegalMoveCard({ move, onApply }: { move: LegalMove; onApply: () => void }) {
  const isHorizontal = new Set(move.placements.map((placement) => placement.row)).size <= 1;
  const orderedPlacements = [...move.placements].sort((left, right) =>
    isHorizontal ? left.col - right.col : left.row - right.row
  );
  const anchor = orderedPlacements[0];

  return (
    <button
      className="grid gap-3 rounded-xl bg-white dark:bg-slate-900 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
      onClick={onApply}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-slate-900 dark:text-white">{move.formedWords.join(", ")}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {anchor ? `row ${anchor.row}, col ${anchor.col}` : ""} · {isHorizontal ? "horizontal" : "vertical"}
          </p>
        </div>
        <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/30 px-3 py-1 text-sm font-bold text-indigo-700 dark:text-indigo-400">{move.score}</span>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`flex rounded-lg bg-slate-100 dark:bg-slate-800 p-2 ${isHorizontal ? "flex-row gap-1" : "flex-col gap-1"}`}>
          {orderedPlacements.map((placement) => (
            <div
              key={`${placement.row}-${placement.col}`}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-white dark:bg-slate-900 text-sm font-bold text-slate-700 dark:text-slate-200 shadow-sm"
            >
              {placement.letter ?? "?"}
            </div>
          ))}
        </div>
        <div className="grid content-start gap-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span>{move.summary}</span>
          <span>{move.placements.length} tile(s)</span>
        </div>
      </div>
    </button>
  );
}

export function ConversationTraceCard({
  trace,
  event,
  mode,
  expanded,
  rack,
  onToggle
}: {
  trace: AgentTrace;
  event: AgentTraceEvent;
  mode: ConversationMode;
  expanded: boolean;
  rack?: Tile[];
  onToggle: () => void;
}) {
  const styles = traceEventClasses(event);
  const showRack = Boolean(rack && rack.length > 0 && (event.kind === "reasoning" || event.kind === "provider_reply" || event.kind === "status"));
  const showFallbackStats = mode === "dev" && trace.turnCount > 0;
  return (
    <div className={`min-w-0 overflow-hidden rounded-lg p-3 ${styles.card}`}>
      <button className="grid min-w-0 w-full gap-3 text-left" onClick={onToggle}>
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-slate-900 dark:text-white">{trace.playerName}</p>
                {showFallbackStats ? (
                  <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
                    {`fail: ${trace.fallbackCount}/${trace.turnCount}`}
                  </span>
                ) : null}
              </div>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${styles.badge}`}>
              {event.kind}
            </span>
          </div>
          <div
            className={`overflow-hidden break-words whitespace-pre-wrap text-sm leading-6 ${styles.content}`}
            style={
              expanded
                ? undefined
                : {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 3 as number
                  }
            }
          >
            {event.content || "(vide)"}
          </div>
          {showRack ? (
            <div className="mt-3 rounded-md bg-white dark:bg-slate-950 p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Rack</p>
              <SmallRack rack={rack ?? []} />
            </div>
          ) : null}
        </div>
        <div className="flex items-end justify-start">
          <ModelLogo trace={trace} size="sm" borderless />
        </div>
      </button>
    </div>
  );
}

export function ChatRow({
  message,
  seat,
  trace
}: {
  message: ChatMessage;
  seat?: PlayerSeat;
  trace?: AgentTrace;
}) {
  const outgoing = message.kind === "agent";
  return (
    <div className={`flex gap-3 ${outgoing ? "flex-row" : "flex-row-reverse"}`}>
      <ModelLogo seat={seat} trace={trace} name={message.authorName} size="sm" borderless />
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 shadow-sm ${
          outgoing ? "rounded-tl-none bg-indigo-600 text-white dark:bg-indigo-500" : "rounded-tr-none bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200"
        }`}
      >
        <p className={`text-xs font-bold ${outgoing ? "text-indigo-100" : "text-slate-400 dark:text-slate-500"}`}>{message.authorName}</p>
        <p className="mt-1 text-sm leading-6 whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}
