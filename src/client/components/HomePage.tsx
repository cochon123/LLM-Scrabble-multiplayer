import type { AuthUserView, RoomSummary } from "../../shared/types";
import { InlineError, RoomCard } from "./shared";

export function HomePage({
  displayName,
  setDisplayName,
  roomCode,
  setRoomCode,
  rooms,
  error,
  authUser,
  authDraftNickname,
  setAuthDraftNickname,
  authDraftPassword,
  setAuthDraftPassword,
  authLoading,
  authError,
  onLogin,
  onRegister,
  onLogout,
  onCreate,
  onJoin,
  onJoinRoom,
  onWatch,
  onDelete
}: {
  displayName: string;
  setDisplayName: (value: string) => void;
  roomCode: string;
  setRoomCode: (value: string) => void;
  rooms: RoomSummary[];
  error: string;
  authUser: AuthUserView | null;
  authDraftNickname: string;
  setAuthDraftNickname: (value: string) => void;
  authDraftPassword: string;
  setAuthDraftPassword: (value: string) => void;
  authLoading: boolean;
  authError: string;
  onLogin: () => void;
  onRegister: () => void;
  onLogout: () => void;
  onCreate: () => void;
  onJoin: () => void;
  onJoinRoom: (roomId: string) => void;
  onWatch: (roomId: string) => void;
  onDelete: (roomId: string) => void;
}) {
  return (
    <div className="min-h-screen overflow-y-auto bg-slate-50 dark:bg-slate-950 px-4 py-6 md:px-6">
      <div className="mx-auto grid max-w-7xl gap-6">
        <section className="rounded-xl bg-white dark:bg-slate-900 p-6 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-500">Scrabble Webapp</p>
              <div className="mt-2 flex items-center gap-3">
                <img src="/scrabble_logo.png" alt="Scrabble Codex" className="h-14 w-14 md:h-20 md:w-20 rounded-xl object-contain" />
                <h1 className="text-5xl font-black tracking-[0.08em] text-slate-900 dark:text-white md:text-7xl">SCRABBLE CODEX</h1>
              </div>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600 dark:text-slate-300">
                Shareable multiplayer rooms, spectator mode, AI agents, real-time chat, and authoritative server-side
                orchestration.
              </p>
            </div>
            <div className="grid gap-4 rounded-xl bg-slate-50 dark:bg-slate-950 p-5">
              {authUser ? (
                <>
                  <div className="rounded-xl bg-white dark:bg-slate-900 p-4">
                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Signed in as</p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xl font-bold text-slate-900 dark:text-white">{authUser.nickname}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{authUser.isAdmin ? "Admin" : "User"}</p>
                      </div>
                      <button className="rounded-xl bg-slate-200 dark:bg-slate-700 px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onLogout}>
                        Sign out
                      </button>
                    </div>
                  </div>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Room code
                    <input
                      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 uppercase outline-none transition focus:border-indigo-500"
                      value={roomCode}
                      onChange={(event) => setRoomCode(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500" onClick={onCreate}>
                      Create room
                    </button>
                    <button className="rounded-xl bg-slate-200 dark:bg-slate-700 px-5 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 transition" onClick={onJoin}>
                      Join as player
                    </button>
                  </div>
                  {error ? <InlineError message={error} /> : null}
                </>
              ) : (
                <>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Nickname
                    <input
                      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 outline-none transition focus:border-indigo-500"
                      value={authDraftNickname}
                      onChange={(event) => setAuthDraftNickname(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Password
                    <input
                      type="password"
                      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 outline-none transition focus:border-indigo-500"
                      value={authDraftPassword}
                      onChange={(event) => setAuthDraftPassword(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 dark:hover:bg-indigo-500 disabled:opacity-50"
                      onClick={onLogin}
                      disabled={authLoading}
                    >
                      Sign in
                    </button>
                    <button
                      className="rounded-xl bg-slate-200 dark:bg-slate-700 px-5 py-3 font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50"
                      onClick={onRegister}
                      disabled={authLoading}
                    >
                      Register
                    </button>
                  </div>
                  {authError ? <InlineError message={authError} /> : null}
                </>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-xl bg-white dark:bg-slate-900 p-6 shadow-xl shadow-slate-200/80 dark:shadow-slate-900/50">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">Directory</p>
              <h2 className="text-3xl font-bold text-slate-900 dark:text-white">Active rooms</h2>
            </div>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{rooms.length} room(s)</span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {rooms.map((room) => (
              <RoomCard
                key={room.roomId}
                room={room}
                onWatch={() => onWatch(room.roomId)}
                onJoin={room.status === "lobby" && room.seatSummaries.some((seat) => seat.enabled && seat.kind === "human" && !seat.occupied) ? () => onJoinRoom(room.roomId) : null}
                onDelete={authUser?.isAdmin ? () => onDelete(room.roomId) : null}
              />
            ))}
            {rooms.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 p-6 text-slate-500 dark:text-slate-400">
                No active rooms right now.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
