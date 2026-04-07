import express from "express";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { Dictionary } from "../shared/dictionary.js";
import type { ClientToServerEvents, RoomDirectoryResponse, ServerToClientEvents } from "../shared/types.js";
import { RoomManager } from "./room-manager.js";

async function bootstrap() {
  const app = express();
  app.use((request, response, next) => {
    response.header("Access-Control-Allow-Origin", request.headers.origin || "*");
    response.header("Access-Control-Allow-Credentials", "true");
    response.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });
  const server = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: true,
      credentials: true
    }
  });

  const dictionaryPath = resolve(process.cwd(), process.env.DICTIONARY_PATH || "public/dictionary/fr-large.txt");
  const dictionary = new Dictionary(await readFile(dictionaryPath, "utf8"));
  const roomManager = new RoomManager(io, dictionary);

  app.get("/api/rooms", (_request, response) => {
    const payload: RoomDirectoryResponse = {
      rooms: roomManager.listRoomSummaries()
    };
    response.json(payload);
  });

  app.get("/api/rooms/:roomId", (request, response) => {
    const clientId = typeof request.query.clientId === "string" ? request.query.clientId : null;
    const view = roomManager.getRoomViewSnapshot(request.params.roomId, clientId);
    if (!view) {
      response.status(404).json({ error: "Room not found." });
      return;
    }
    response.json(view);
  });

  io.on("connection", (socket) => {
    roomManager.attach(socket);
  });

  if (process.env.NODE_ENV === "production") {
    app.use(express.static(resolve(process.cwd(), "dist")));
    app.get("*", (_request, response) => {
      response.sendFile(resolve(process.cwd(), "dist/index.html"));
    });
  } else {
    app.get("/health", (_request, response) => {
      response.json({
        ok: true,
        dictionaryWords: dictionary.count()
      });
    });
  }

  const port = Number(process.env.PORT || 3001);
  server.listen(port, () => {
    console.log(`scrabble-codex listening on http://localhost:${port}`);
  });
}

void bootstrap();
