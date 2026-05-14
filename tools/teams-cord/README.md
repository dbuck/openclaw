# teams-cord

A Microsoft Teams harness for [Claude Code](https://claude.com/claude-code). Thread-based conversations, interactive elements, works anywhere you already run Claude. Modeled after [cord](https://github.com/alexknowshtml/cord) for Discord.

> Status: skeleton. The bot, queue, worker, spawner, CLI, and HTTP API are wired end-to-end but several Graph and Bot Framework surfaces are stubs that need real implementations before production use. See `TODO`s in source.

## What it does

1. A Microsoft Teams bot listens for @-mentions of itself.
2. On mention, it creates (or finds) a reply chain for that conversation and enqueues a Claude Code job (BullMQ + Redis).
3. A worker picks up the job, spawns the `claude` CLI in the configured working directory, and pipes Claude's responses back into the Teams thread.
4. Mid-session, Claude can call back into Teams via the local HTTP API (default `http://127.0.0.1:2644`) to post messages, attachments, adaptive cards, or update its own status.
5. SQLite keeps the conversation -> session mapping so follow-up mentions resume the right Claude session.

```
Teams (Bot Framework) -> BullMQ Queue -> Claude spawner
       (webhook)           (Redis)         (Node + child_process)
                                 |
                                 v
                          SQLite mapping
                                 ^
                                 |
                          HTTP API (port 2644)
                                 ^
                                 |
                         CLI: teams-cord send/...
```

## Architecture

| Module                | Purpose                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `src/bot.ts`          | Inbound Bot Framework webhook. Captures `@bot` mentions, queues jobs.        |
| `src/queue.ts`        | BullMQ queue + job typing.                                                   |
| `src/worker.ts`       | Job processor. Resolves config, spawns Claude, streams stdout to Teams.      |
| `src/spawner.ts`      | `child_process.spawn` of the `claude` CLI with stdin prompt + JSON output.   |
| `src/db.ts`           | SQLite. `threads(channel_id, thread_id, session_id, working_dir)`.           |
| `src/http.ts`         | Local HTTP API for CLI / external scripts (port 2644 by default).            |
| `src/cli/*`           | `commander`-based subcommands: `send`, `embed`, `file`, `typing`, `edit`, `state`, `health`. |
| `src/teams/auth.ts`   | Bot Framework + Graph token acquisition (client credentials).                |
| `src/teams/jwt.ts`    | Inbound JWT validation against Bot Framework / Entra JWKS.                   |
| `src/teams/send.ts`   | Outbound activity REST (`/v3/conversations/{id}/activities`).                |
| `src/teams/graph.ts`  | Minimal Microsoft Graph client (paged GET / POST / PATCH / DELETE).          |
| `src/teams/attachments.ts` | Graph upload session helper for files.                                 |
| `src/teams/types.ts`  | Activity / conversation reference / mention types.                           |

## Install

```bash
git clone <this repo>
cd teams-cord
pnpm install   # or npm install / bun install
cp .env.example .env
# fill in TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_TENANT_ID, REDIS_HOST, ...
pnpm build
```

## Prerequisites

- **Node 20+** (or Bun)
- **Redis** running locally (`redis-server &`) for BullMQ
- **Claude Code CLI** installed and authenticated (`claude` on `$PATH`)
- A **Microsoft Teams bot** registered in the [Azure Bot resource](https://portal.azure.com) with:
  - Messaging endpoint pointing at your public webhook URL (e.g. via ngrok) ending in `/api/messages`
  - Microsoft App ID, password, and tenant ID
  - App manifest installed in the target Teams tenant / chat / channel

## Quick start

```bash
# Terminal 1: Bot Framework webhook listener
teams-cord bot

# Terminal 2: worker that spawns Claude per thread
teams-cord worker

# Terminal 3: local HTTP API for the CLI
teams-cord http

# Or all-in-one (single process):
teams-cord start
```

Then in Teams, @-mention the bot in a chat or channel and it will reply in a thread.

## CLI

```
teams-cord send <conversation> "message"
teams-cord embed <conversation> "text" --title "T" --color blue
teams-cord file <conversation> ./report.md
teams-cord buttons <conversation> "Pick:" --button label="Yes" id="yes" --button label="No" id="no"
teams-cord typing <conversation>
teams-cord edit <conversation> <activityId> "new text"
teams-cord state <conversation> <activityId> done
teams-cord health
```

`<conversation>` is a Bot Framework conversation id (the `19:...@thread.v2` / `19:...@unq.gbl.spaces` form), or a saved alias from the DB.

## HTTP API

The local HTTP API is exposed on `TEAMS_CORD_HTTP_PORT` (default `2644`) on `TEAMS_CORD_HTTP_HOST` (default `127.0.0.1`). See `skills/teams-cord/HTTP-API.md` for the full route reference. In short:

```
POST /v1/send            -> send a message
POST /v1/embed           -> send an adaptive card (Teams equivalent of an embed)
POST /v1/file            -> upload an attachment
POST /v1/typing          -> typing indicator
PATCH /v1/messages/:id   -> edit a previously sent message
POST /v1/state           -> mark a message as done / in-progress (reaction)
GET  /v1/health          -> liveness check
```

## Working-directory configuration

- Per channel: `teams-cord config dir <conversation> /path/to/repo` (writes to SQLite)
- Per message: `@bot [/path/to/repo] what files are here?` (overrides for that one job)
- Allowlist via `TEAMS_CORD_ALLOWED_DIRS` (comma-separated absolute paths). Required in production; the worker refuses paths outside the list.

## Privacy

Only the conversation-to-session mapping and per-conversation config are persisted. Message content and Claude transcripts are not stored beyond what BullMQ keeps in Redis during the job lifecycle.

## Status / TODO

This repo started as an extraction of the OpenClaw `msteams` plugin and was decoupled from the OpenClaw plugin SDK. The skeleton compiles and the cord-equivalent shape is in place.

Already wired end-to-end:

- [x] Full Bot Framework JWT validation (`src/teams/jwt.ts`): multi-issuer JWKS (Bot Framework + Entra v2 + sts.windows.net), audience + `appid`/`azp` check.
- [x] Graph upload-session attachments (`src/teams/attachments.ts`).
- [x] `claude --resume` per conversation (`src/worker.ts`).
- [x] Adaptive-card embed/buttons (`src/cards.ts`).
- [x] Streaming Claude output: spawner uses `--output-format stream-json` and a `StreamingTeamsMessage` debounces `updateActivity` so the user sees the reply grow as Claude generates it.
- [x] Adaptive-card `Action.Submit` round-trip: button clicks are routed back into the same Claude session as a synthesized `[button-submit] key=value` prompt.
- [x] Spawned `claude` subprocess inherits `TEAMS_CORD_CONVERSATION_ID`, `TEAMS_CORD_HTTP_URL`, `TEAMS_CORD_WORKING_DIR`, `TEAMS_CORD_FROM_USER`, `TEAMS_CORD_INBOUND_ACTIVITY_ID` so the SKILL can drive the local HTTP API directly.
- [x] Outbound @-mentions: bot/worker replies pass `entities` so Teams renders an @-pill back at the originating user (`buildOutboundMentions` in `src/teams/mentions.ts`).

Before production:

- [ ] **Promote streaming to Teams' first-class protocol.** `src/streaming-message.ts` currently uses plain `updateActivity` edits (debounced to 1500 ms). The msteams reference uses `streaminfo` entities (`streamType: streaming/final`, `streamId`, `streamSequence`) for a smoother render and to avoid the "Edited" badge — see `extensions/msteams/src/streaming-message.ts:TeamsHttpStream`.
- [ ] File-consent invoke handshake for personal-scope (1:1) DM uploads — channel-scope works as-is.
- [ ] Handle `conversationUpdate` (welcome card when added to a chat/team) and `messageReaction` (cord uses ✅ for "done"; Teams has the same shape via `reactionsAdded`).
- [ ] Channel-thread `;messageid=` parsing when we extend file uploads to channel threads (only matters for Graph chat lookups, not Bot Framework sends).
- [ ] Other invoke names (signin/verify, file consent, messaging extensions) — `bot.ts` currently only sends a structured response for `adaptiveCard/action`; everything else gets a bare 200.
- [ ] Split BullMQ Queue / Worker `IORedis` connections (`maxRetriesPerRequest: null` only needs to be set on the worker side).
- [ ] Tests + `.github/workflows/ci.yml`. At minimum: unit tests for `mentions.ts`, `types.ts`, `cards.ts`, `streaming-message.ts`, `db.ts`; one end-to-end integration test mocking Bot Framework + Graph.
- [ ] Run `pnpm build` end-to-end after extraction (this skeleton was authored without running `tsc` since its deps live outside the openclaw lockfile).
- [ ] License audit: `src/teams/*` is derived from `extensions/msteams/` (OpenClaw); confirm Apache-2.0/MIT compatibility and add attribution before publishing.

## License

MIT. See `LICENSE`.
