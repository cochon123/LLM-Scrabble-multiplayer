import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import type { AuthUserView, DefaultApiKeys, PlayerSeat, RoomOptions } from "../shared/types.js";

const ADMIN_NICKNAME = "admin";
const ADMIN_PASSWORD = "admin123";
const SESSION_TTL_DAYS = 30;

interface PersistedUserRecord extends AuthUserView {
  passwordHash?: string | null;
}

export interface ReplayEventRecord {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ReplayGameRecord {
  id: string;
  roomCode: string;
  status: string;
  hostUserId: string | null;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  players: Array<{
    seatIndex: number;
    userId: string | null;
    name: string;
    kind: string;
    agentProvider: string | null;
    agentModel: string | null;
    connected: boolean;
  }>;
  events: ReplayEventRecord[];
}

export interface Persistence {
  readonly enabled: boolean;
  init(): Promise<void>;
  upsertUser(userId: string, name: string): Promise<void>;
  registerUser(nickname: string, password: string): Promise<AuthUserView>;
  loginUser(nickname: string, password: string): Promise<AuthUserView>;
  createSession(userId: string): Promise<string>;
  getUserBySessionToken(token: string): Promise<AuthUserView | null>;
  saveDefaultApiKey(userId: string, provider: keyof DefaultApiKeys, apiKey: string): Promise<AuthUserView>;
  createGame(input: {
    gameId: string;
    roomCode: string;
    hostUserId: string;
    options: RoomOptions;
    seats: PlayerSeat[];
  }): Promise<void>;
  upsertGameSeat(gameId: string, seat: PlayerSeat, userId?: string | null): Promise<void>;
  updateGame(input: {
    gameId: string;
    status?: string;
    options?: RoomOptions;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    result?: Record<string, unknown> | null;
  }): Promise<void>;
  appendGameEvent(gameId: string, type: string, payload: Record<string, unknown>, createdAt?: Date): Promise<void>;
  getReplay(gameId: string): Promise<ReplayGameRecord | null>;
  deleteGame(gameId: string): Promise<boolean>;
}

export async function createPersistence(connectionString?: string): Promise<Persistence> {
  if (!connectionString) {
    return new NoopPersistence();
  }
  const persistence = new PostgresPersistence(connectionString);
  await persistence.init();
  return persistence;
}

class NoopPersistence implements Persistence {
  readonly enabled = false;

  async init(): Promise<void> {}
  async upsertUser(): Promise<void> {}
  async registerUser(): Promise<AuthUserView> {
    throw new Error("Authentication requires DATABASE_URL.");
  }
  async loginUser(): Promise<AuthUserView> {
    throw new Error("Authentication requires DATABASE_URL.");
  }
  async createSession(): Promise<string> {
    throw new Error("Authentication requires DATABASE_URL.");
  }
  async getUserBySessionToken(): Promise<AuthUserView | null> {
    return null;
  }
  async saveDefaultApiKey(): Promise<AuthUserView> {
    throw new Error("Authentication requires DATABASE_URL.");
  }
  async createGame(): Promise<void> {}
  async upsertGameSeat(): Promise<void> {}
  async updateGame(): Promise<void> {}
  async appendGameEvent(): Promise<void> {}
  async getReplay(): Promise<ReplayGameRecord | null> {
    return null;
  }
  async deleteGame(): Promise<boolean> {
    return false;
  }
}

class PostgresPersistence implements Persistence {
  readonly enabled = true;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password_hash TEXT,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        host_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS game_players (
        id BIGSERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        seat_index INTEGER NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        connected BOOLEAN NOT NULL DEFAULT FALSE,
        agent_provider TEXT,
        agent_model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (game_id, seat_index)
      );

      CREATE TABLE IF NOT EXISTS game_events (
        id BIGSERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS game_events_game_id_id_idx ON game_events (game_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users ((LOWER(name)));

      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  }

  async upsertUser(userId: string, name: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO users (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
      `,
      [userId, name]
    );
  }

  async registerUser(nickname: string, password: string): Promise<AuthUserView> {
    if (!nickname.trim()) {
      throw new Error("Nickname is required.");
    }
    if (!password) {
      throw new Error("Password is required.");
    }
    if (nickname.trim().toLowerCase() === ADMIN_NICKNAME) {
      throw new Error("This nickname is reserved.");
    }
    const existing = await this.findUserByName(nickname);
    if (existing) {
      throw new Error("Nickname already exists.");
    }
    const userId = randomBytes(16).toString("hex");
    await this.pool.query(
      `
        INSERT INTO users (id, name, password_hash, is_admin, settings_json)
        VALUES ($1, $2, $3, FALSE, '{}'::jsonb)
      `,
      [userId, nickname.trim(), hashPassword(password)]
    );
    return {
      userId,
      nickname: nickname.trim(),
      isAdmin: false,
      defaultApiKeys: {}
    };
  }

  async loginUser(nickname: string, password: string): Promise<AuthUserView> {
    const normalized = nickname.trim();
    if (!normalized || !password) {
      throw new Error("Nickname and password are required.");
    }

    if (normalized.toLowerCase() === ADMIN_NICKNAME) {
      if (password !== ADMIN_PASSWORD) {
        throw new Error("Invalid nickname or password.");
      }
      await this.pool.query(
        `
          INSERT INTO users (id, name, password_hash, is_admin, settings_json)
          VALUES ('admin', 'admin', NULL, TRUE, '{}'::jsonb)
          ON CONFLICT (id)
          DO UPDATE SET
            name = EXCLUDED.name,
            is_admin = TRUE,
            updated_at = NOW()
        `
      );
      return {
        userId: "admin",
        nickname: "admin",
        isAdmin: true,
        defaultApiKeys: {}
      };
    }

    const user = await this.findUserByName(normalized);
    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new Error("Invalid nickname or password.");
    }
    return toAuthUserView(user);
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.pool.query(
      `
        INSERT INTO user_sessions (token, user_id, expires_at)
        VALUES ($1, $2, $3)
      `,
      [token, userId, expiresAt]
    );
    return token;
  }

  async getUserBySessionToken(token: string): Promise<AuthUserView | null> {
    if (!token) {
      return null;
    }
    const result = await this.pool.query(
      `
        SELECT u.id, u.name, u.is_admin, u.settings_json
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = $1
          AND s.expires_at > NOW()
      `,
      [token]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      userId: row.id,
      nickname: row.name,
      isAdmin: row.is_admin,
      defaultApiKeys: ((row.settings_json ?? {}) as { defaultApiKeys?: DefaultApiKeys }).defaultApiKeys ?? {}
    };
  }

  async saveDefaultApiKey(userId: string, provider: keyof DefaultApiKeys, apiKey: string): Promise<AuthUserView> {
    const user = await this.pool.query(
      `
        UPDATE users
        SET settings_json = jsonb_set(
          COALESCE(settings_json, '{}'::jsonb),
          '{defaultApiKeys}',
          COALESCE(settings_json->'defaultApiKeys', '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
          true
        ),
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, is_admin, settings_json
      `,
      [userId, provider, apiKey]
    );
    if (user.rowCount === 0) {
      throw new Error("User not found.");
    }
    const row = user.rows[0];
    return {
      userId: row.id,
      nickname: row.name,
      isAdmin: row.is_admin,
      defaultApiKeys: ((row.settings_json ?? {}) as { defaultApiKeys?: DefaultApiKeys }).defaultApiKeys ?? {}
    };
  }

  async createGame(input: {
    gameId: string;
    roomCode: string;
    hostUserId: string;
    options: RoomOptions;
    seats: PlayerSeat[];
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO games (id, room_code, status, host_user_id, config_json)
        VALUES ($1, $2, 'lobby', $3, $4::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET
          room_code = EXCLUDED.room_code,
          host_user_id = EXCLUDED.host_user_id,
          config_json = EXCLUDED.config_json,
          updated_at = NOW()
      `,
      [input.gameId, input.roomCode, input.hostUserId, JSON.stringify({ options: input.options })]
    );

    for (const seat of input.seats) {
      await this.upsertGameSeat(input.gameId, seat);
    }
  }

  async upsertGameSeat(gameId: string, seat: PlayerSeat, userId?: string | null): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO game_players (
          game_id,
          seat_index,
          user_id,
          name,
          kind,
          connected,
          agent_provider,
          agent_model
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (game_id, seat_index)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          name = EXCLUDED.name,
          kind = EXCLUDED.kind,
          connected = EXCLUDED.connected,
          agent_provider = EXCLUDED.agent_provider,
          agent_model = EXCLUDED.agent_model,
          updated_at = NOW()
      `,
      [
        gameId,
        seat.seatIndex,
        seat.kind === "human" ? userId ?? null : null,
        seat.name,
        seat.kind,
        seat.connected,
        seat.agentConfig?.provider ?? null,
        seat.agentConfig?.model ?? null
      ]
    );
  }

  async updateGame(input: {
    gameId: string;
    status?: string;
    options?: RoomOptions;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    result?: Record<string, unknown> | null;
  }): Promise<void> {
    const assignments: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [input.gameId];

    if (input.status !== undefined) {
      values.push(input.status);
      assignments.push(`status = $${values.length}`);
    }
    if (input.options !== undefined) {
      values.push(JSON.stringify({ options: input.options }));
      assignments.push(`config_json = $${values.length}::jsonb`);
    }
    if (input.startedAt !== undefined) {
      values.push(input.startedAt);
      assignments.push(`started_at = $${values.length}`);
    }
    if (input.finishedAt !== undefined) {
      values.push(input.finishedAt);
      assignments.push(`finished_at = $${values.length}`);
    }
    if (input.result !== undefined) {
      values.push(input.result ? JSON.stringify(input.result) : null);
      assignments.push(`result_json = $${values.length}::jsonb`);
    }

    await this.pool.query(`UPDATE games SET ${assignments.join(", ")} WHERE id = $1`, values);
  }

  async appendGameEvent(gameId: string, type: string, payload: Record<string, unknown>, createdAt?: Date): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO game_events (game_id, type, payload_json, created_at)
        VALUES ($1, $2, $3::jsonb, COALESCE($4, NOW()))
      `,
      [gameId, type, JSON.stringify(payload), createdAt ?? null]
    );
    await this.pool.query(`UPDATE games SET updated_at = NOW() WHERE id = $1`, [gameId]);
  }

  async getReplay(gameId: string): Promise<ReplayGameRecord | null> {
    const gameResult = await this.pool.query(
      `
        SELECT
          id,
          room_code,
          status,
          host_user_id,
          config_json,
          result_json,
          created_at,
          started_at,
          finished_at
        FROM games
        WHERE id = $1
      `,
      [gameId]
    );

    if (gameResult.rowCount === 0) {
      return null;
    }

    const playersResult = await this.pool.query(
      `
        SELECT seat_index, user_id, name, kind, connected, agent_provider, agent_model
        FROM game_players
        WHERE game_id = $1
        ORDER BY seat_index ASC
      `,
      [gameId]
    );

    const eventsResult = await this.pool.query(
      `
        SELECT id, type, payload_json, created_at
        FROM game_events
        WHERE game_id = $1
        ORDER BY id ASC
      `,
      [gameId]
    );

    const game = gameResult.rows[0];
    return {
      id: game.id,
      roomCode: game.room_code,
      status: game.status,
      hostUserId: game.host_user_id,
      config: (game.config_json ?? {}) as Record<string, unknown>,
      result: (game.result_json ?? null) as Record<string, unknown> | null,
      createdAt: game.created_at.toISOString(),
      startedAt: game.started_at ? game.started_at.toISOString() : null,
      finishedAt: game.finished_at ? game.finished_at.toISOString() : null,
      players: playersResult.rows.map((row) => ({
        seatIndex: row.seat_index,
        userId: row.user_id,
        name: row.name,
        kind: row.kind,
        agentProvider: row.agent_provider,
        agentModel: row.agent_model,
        connected: row.connected
      })),
      events: eventsResult.rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        payload: row.payload_json as Record<string, unknown>,
        createdAt: row.created_at.toISOString()
      }))
    };
  }

  async deleteGame(gameId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM games WHERE id = $1`, [gameId]);
    return (result.rowCount ?? 0) > 0;
  }

  private async findUserByName(nickname: string): Promise<PersistedUserRecord | null> {
    const result = await this.pool.query(
      `
        SELECT id, name, password_hash, is_admin, settings_json
        FROM users
        WHERE LOWER(name) = LOWER($1)
        LIMIT 1
      `,
      [nickname.trim()]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      userId: row.id,
      nickname: row.name,
      isAdmin: row.is_admin,
      defaultApiKeys: ((row.settings_json ?? {}) as { defaultApiKeys?: DefaultApiKeys }).defaultApiKeys ?? {},
      passwordHash: row.password_hash
    };
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) {
    return false;
  }
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
}

function toAuthUserView(user: PersistedUserRecord): AuthUserView {
  return {
    userId: user.userId,
    nickname: user.nickname,
    isAdmin: user.isAdmin,
    defaultApiKeys: user.defaultApiKeys
  };
}
