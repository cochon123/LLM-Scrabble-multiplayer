import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { Dictionary } from "../shared/dictionary.js";
import type { AuthUserView, ClientToServerEvents, RoomDirectoryResponse, ServerToClientEvents } from "../shared/types.js";
import { createPersistence } from "./persistence.js";
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

  const dictionaryPath = resolve(process.cwd(), process.env.DICTIONARY_PATH || "public/dictionary/en-large.txt");
  const dictionary = new Dictionary(await readFile(dictionaryPath, "utf8"));
  const persistence = await createPersistence(process.env.DATABASE_URL);
  const roomManager = new RoomManager(io, dictionary, persistence);

  async function getAuthenticatedUser(request: express.Request): Promise<AuthUserView | null> {
    const authHeader = request.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    if (!token) {
      return null;
    }
    return persistence.getUserBySessionToken(token);
  }

  app.post("/api/auth/register", express.json(), async (request, response) => {
    if (!persistence.enabled) {
      response.status(503).json({ error: "Authentication requires DATABASE_URL." });
      return;
    }
    try {
      const nickname = String(request.body?.nickname ?? "");
      const password = String(request.body?.password ?? "");
      const user = await persistence.registerUser(nickname, password);
      const token = await persistence.createSession(user.userId);
      response.json({ token, user });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Registration failed." });
    }
  });

  app.post("/api/auth/login", express.json(), async (request, response) => {
    if (!persistence.enabled) {
      response.status(503).json({ error: "Authentication requires DATABASE_URL." });
      return;
    }
    try {
      const nickname = String(request.body?.nickname ?? "");
      const password = String(request.body?.password ?? "");
      const user = await persistence.loginUser(nickname, password);
      const token = await persistence.createSession(user.userId);
      response.json({ token, user });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Login failed." });
    }
  });

  app.get("/api/auth/me", async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    response.json({ user });
  });

  app.post("/api/auth/default-api-key", express.json(), async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    try {
      const provider = String(request.body?.provider ?? "") as keyof AuthUserView["defaultApiKeys"];
      const apiKey = String(request.body?.apiKey ?? "").trim();
      if (!apiKey) {
        response.status(400).json({ error: "API key is required." });
        return;
      }
      const nextUser = await persistence.saveDefaultApiKey(user.userId, provider, apiKey);
      response.json({ user: nextUser });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Could not save default API key." });
    }
  });

  app.get("/api/rooms", async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    const payload: RoomDirectoryResponse = {
      rooms: roomManager.listRoomSummaries()
    };
    response.json(payload);
  });

  app.get("/api/rooms/:roomId", async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    const clientId = typeof request.query.clientId === "string" ? request.query.clientId : null;
    const view = roomManager.getRoomViewSnapshot(request.params.roomId, clientId);
    if (!view) {
      response.status(404).json({ error: "Room not found." });
      return;
    }
    response.json(view);
  });

  app.get("/api/games/:gameId/replay", async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    if (!persistence.enabled) {
      response.status(503).json({ error: "Postgres persistence is not configured." });
      return;
    }
    const replay = await persistence.getReplay(request.params.gameId);
    if (!replay) {
      response.status(404).json({ error: "Game not found." });
      return;
    }
    response.json(replay);
  });

  app.delete("/api/games/:gameId", async (request, response) => {
    const user = await getAuthenticatedUser(request);
    if (!user?.isAdmin) {
      response.status(403).json({ error: "Admin access required." });
      return;
    }
    const deleted = await roomManager.deleteRoom(request.params.gameId);
    const deletedFromDb = await persistence.deleteGame(request.params.gameId);
    if (!deleted && !deletedFromDb) {
      response.status(404).json({ error: "Game not found." });
      return;
    }
    response.json({ ok: true });
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
        dictionaryWords: dictionary.count(),
        persistence: persistence.enabled
      });
    });
  }

  const port = Number(process.env.PORT || 3001);
  server.listen(port, () => {
    console.log(`scrabble-codex listening on http://localhost:${port}`);
  });
}

void bootstrap();
