# LLM Scrabble Multiplayer

Real-time Scrabble where humans and language models can play in the same room.

This project is built around a simple idea: LLMs should be able to **play with people**, **play against people**, and **play against each other** in a real multiplayer game, without ever being allowed to corrupt the board state. The server stays authoritative, every move is validated, and agent behavior is observable through chat and trace views.

It is, to our knowledge, the first project focused on **multiplayer LLM vs Human and LLM vs LLM Scrabble gameplay** in one shared live experience.

We are also planning to release a **leaderboard**.

## Screenshots

### Home / Lobby

![Home and lobby](docs/screenshots/home_lobby.png)

### Game Room

![Game room](docs/screenshots/game_room.png)

## What It Does

- live multiplayer Scrabble rooms with shareable URLs
- human vs human, human vs LLM, and LLM vs LLM games
- spectator mode
- per-seat model/provider configuration
- real-time chat between humans and agents
- agent reasoning and trace views with multiple visibility modes
- persistent game storage with PostgreSQL
- replay endpoint for completed games
- admin controls to delete games
- benchmark tooling to evaluate different LLM move-output formats

## Why It Exists

FOR FUN, I just wanted a easy way to see if AI can play scrable, and i wanted an easy way to that.

## How The Agent System Works

Agents do not directly rewrite the game board.

They receive structured context and can only act through server tools such as:

- `get_state {}`
- `list_legal_moves {"limit": number}` when allowed
- `play_move {"placements":[{"row":number,"col":number,"letter":"A"}]}`
- `exchange_tiles {"letters":["A","E"]}`
- `send_chat {"message":"..."}`
- `pass_turn {}`

The server:

1. validates the tool payload
2. checks the move against the real Scrabble rules
3. applies it only if it is legal
4. returns structured failure details otherwise

This means models can fail often, but the game still stays correct.

## Tech Stack

- React 19
- Vite
- Node.js
- Express
- Socket.IO
- TypeScript
- PostgreSQL
- Vitest

## Project Structure

```text
src/
  client/
    App.tsx
    main.tsx
  server/
    ai.ts
    index.ts
    logger.ts
    persistence.ts
    room_manager.ts
  shared/
    agent_prompt.ts
    constants.ts
    dictionary.ts
    game.ts
    types.ts
build/
  client/
  server/
var/
  bench/
  logs/
  postgres/
public/
  dictionary/
    en_large.txt
    fr_basic.txt
    fr_large.txt
  logos/
```

## Requirements

- Node.js 20+
- npm
- PostgreSQL if you want auth, persistent games, and replay storage

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file:

```bash
DATABASE_URL=postgres://scrabble_codex:scrabble_codex@localhost:5432/scrabble_codex
PORT=3001
DICTIONARY_PATH=public/dictionary/en_large.txt
ADMIN_NICKNAME=admin
ADMIN_PASSWORD=change_me
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
AUTH_COOKIE_NAME=scrabble_codex_session
AUTH_COOKIE_SECURE=false
```

### 3. Create the PostgreSQL database

Example:

```sql
CREATE ROLE scrabble_codex LOGIN PASSWORD 'scrabble_codex';
CREATE DATABASE scrabble_codex OWNER scrabble_codex;
```

### 4. Start the app

```bash
npm run dev
```

Default URLs:

- frontend: `http://localhost:5173`
- backend: `http://localhost:3001`

### Production build

```bash
npm run build
npm start
```

Build output is written to `build/`, and local runtime data lives under `var/`.

## Authentication

The app uses a deliberately simple auth system:

- nickname
- password
- HTTP-only session cookie

Admin access is configured through `.env`:

- nickname: `ADMIN_NICKNAME`
- password: `ADMIN_PASSWORD`

Admin can delete games, including games that are still running.

## Persistence

When `DATABASE_URL` is configured, the server stores:

- users
- sessions
- games
- player seats
- append-only game events

Replay data is available through:

- `GET /api/games/:gameId/replay`

If `DATABASE_URL` is not configured, the app can still run in memory, but auth and persistence-dependent features are disabled.

## Providers

Supported providers in the UI:

- `openai_compatible`
- `openrouter`
- `google`
- `ollama`

API keys can be entered in the UI. When a user enters or changes a key, the app can store it as that user’s default key for the provider.

Saved default provider keys are resolved on the server and are never sent back to the browser. The UI only indicates when a saved default is being used.

Current UI presets:

- `openai_compatible` -> `http://127.0.0.1:1234/v1/chat/completions`
- `openrouter` -> `https://openrouter.ai/api/v1/chat/completions`
- `google` -> native Google API flow
- `ollama` -> `http://127.0.0.1:11434/api/chat`

## Dictionary

The default runtime dictionary is:

- `public/dictionary/en_large.txt`

It is a stricter curated English list derived from the system `american-english` dictionary, with a conservative allowlist of short two-letter words. This avoids junk entries such as:

- `ZS`
- `LG`
- `IE`

All words are normalized before use:

- diacritics removed
- non-letters stripped
- uppercased

## Benchmarks

This repo also includes a terminal benchmark suite for testing different LLM move-output interfaces on guided Scrabble placement tasks.

Location:

- [benchmarks/scrabble_toolcall](/home/cochon/Documents/miniproject/scrabble_codex/benchmarks/scrabble_toolcall)

It supports:

- dataset generation
- provider/model evaluation
- error taxonomy
- charts and summaries

There is also an `autoresearch` harness for automated prompt/tool-interface exploration.

## Tests

Run:

```bash
npm test
```

Build:

```bash
npm run build
```

## Current Status

The project already supports full live gameplay, agent reasoning visibility, persistence, replay logging, benchmark tooling, and admin moderation.

Next planned work includes:

- leaderboard release
- stronger production deployment setup
- better curated English Scrabble lexicons
- more agent-vs-agent evaluation and matchmaking features

## License

No license file has been added yet.
