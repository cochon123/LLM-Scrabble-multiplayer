import type { ServerToClientEvents, ClientToServerEvents } from "../../shared/types";
import type { Socket } from "socket.io-client";

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const API_BASE_URL = import.meta.env.DEV ? "http://localhost:3001" : "";

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include"
  });
}

export function ensureSocketReady(
  socket: ClientSocket,
  clientId: string,
  displayName: string,
  callback?: () => void
) {
  socket.auth = {
    clientId,
    displayName
  };
  if (socket.connected) {
    callback?.();
    return;
  }
  socket.once("connect", () => callback?.());
  if (!socket.active) {
    socket.connect();
  }
}
