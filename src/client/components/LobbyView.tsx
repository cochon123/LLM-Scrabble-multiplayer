import type { AgentConfig, AgentProvider, AuthUserView, PlayerSeat, RoomView } from "../../shared/types";
import { InlineError } from "./shared";
import { SeatEditor } from "./SeatEditor";

export function LobbyView({
  view,
  error,
  isHost,
  updateSeat,
  defaultApiKeys,
  onSaveDefaultApiKey,
  updateRoomOption,
  startGame
}: {
  view: RoomView;
  error: string;
  isHost: boolean;
  updateSeat: (seat: PlayerSeat, patch: Partial<PlayerSeat> & { agentConfig?: AgentConfig }) => void;
  defaultApiKeys: AuthUserView["defaultApiKeys"];
  onSaveDefaultApiKey: (provider: AgentProvider, apiKey: string) => void;
  updateRoomOption: (showLegalMoves: boolean) => void;
  startGame: () => void;
}) {
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-indigo-500">Public lobby</p>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-white">Configure room</h2>
          <p className="mt-2 text-slate-600 dark:text-slate-300">Spectators can watch this room live and send chat messages.</p>
        </div>
        {isHost ? (
          <button className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500" onClick={startGame}>
            Start game
          </button>
        ) : null}
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="rounded-xl bg-slate-50 dark:bg-slate-950 p-4">
        <label className="flex items-center gap-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 dark:border-slate-600 text-indigo-600"
            checked={view.options.showLegalMoves}
            disabled={!isHost}
            onChange={(event) => updateRoomOption(event.target.checked)}
          />
          Allow legal move suggestions for human players
        </label>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {view.game.players.map((seat) => (
          <SeatEditor
            key={seat.id}
            seat={seat}
            disabled={!isHost || view.game.started}
            defaultApiKeys={defaultApiKeys}
            onSaveDefaultApiKey={onSaveDefaultApiKey}
            onChange={updateSeat}
          />
        ))}
      </div>
    </div>
  );
}
