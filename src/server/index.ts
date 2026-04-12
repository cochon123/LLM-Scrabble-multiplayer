import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { Dictionary } from "../shared/dictionary.js";
import type { AuthUserView, ClientToServerEvents, RoomDirectoryResponse, ServerToClientEvents } from "../shared/types.js";
import { getAllowedOrigins, getSessionCookieName, isOriginAllowed, parseCookieHeader, useSecureCookies } from "./http_security.js";
import { createPersistence } from "./persistence.js";
import { RoomManager } from "./room_manager.js";

async function bootstrap() {
  const allowedOrigins = new Set(getAllowedOrigins());
  const app = express();
  app.use((request, response, next) => {
    const requestOrigin = request.headers.origin;
    if (requestOrigin && isOriginAllowed(requestOrigin, allowedOrigins)) {
      response.header("Access-Control-Allow-Origin", requestOrigin);
      response.header("Vary", "Origin");
      response.header("Access-Control-Allow-Credentials", "true");
    }
    response.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
        response.sendStatus(403);
        return;
      }
      response.sendStatus(204);
      return;
    }
    next();
  });
  const server = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: (origin, callback) => callback(null, isOriginAllowed(origin, allowedOrigins)),
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true
    }
  });

  const dictionaryPath = resolve(process.cwd(), process.env.DICTIONARY_PATH || "public/dictionary/en_large.txt");
  const dictionary = new Dictionary(await readFile(dictionaryPath, "utf8"));
  const persistence = await createPersistence(process.env.DATABASE_URL);
  const roomManager = new RoomManager(io, dictionary, persistence);

  async function getAuthenticatedUser(request: express.Request): Promise<AuthUserView | null> {
    const sessionCookieName = getSessionCookieName();
    const cookieToken = parseCookieHeader(request.header("cookie"))[sessionCookieName] ?? "";
    const authHeader = request.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const token = cookieToken || bearerToken;
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
      setSessionCookie(response, token);
      response.json({ user });
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
      setSessionCookie(response, token);
      response.json({ user });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Login failed." });
    }
  });

  app.post("/api/auth/logout", (_request, response) => {
    clearSessionCookie(response);
    response.json({ ok: true });
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
    app.use(express.static(resolve(process.cwd(), "build/client")));
    app.get("*", (_request, response) => {
      response.sendFile(resolve(process.cwd(), "build/client/index.html"));
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

function setSessionCookie(response: express.Response, token: string): void {
  response.cookie(getSessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(response: express.Response): void {
  response.clearCookie(getSessionCookieName(), {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/"
  });
}
