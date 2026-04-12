import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_ROOT = join(process.cwd(), "var", "logs", "rooms");
const writeQueues = new Map<string, Promise<void>>();

export interface RoomLogEntry {
  timestamp: string;
  roomId: string;
  type: string;
  payload: Record<string, unknown>;
}

export function getRoomLogPath(roomId: string): string {
  return join(LOG_ROOT, `${sanitizeSegment(roomId)}.jsonl`);
}

export function appendRoomLog(roomId: string, type: string, payload: Record<string, unknown> = {}): void {
  const filePath = getRoomLogPath(roomId);
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), roomId, type, payload } satisfies RoomLogEntry)}\n`;
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(LOG_ROOT, { recursive: true });
      await appendFile(filePath, line, "utf8");
    });

  writeQueues.set(filePath, next);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
