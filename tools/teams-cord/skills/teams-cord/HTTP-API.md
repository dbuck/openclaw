# teams-cord HTTP API

The teams-cord process exposes a local HTTP API at `http://${TEAMS_CORD_HTTP_HOST:-127.0.0.1}:${TEAMS_CORD_HTTP_PORT:-2644}` for the CLI and for coding agents to drive Microsoft Teams from inside their session.

> The API has no authentication. Bind to localhost only (the default) unless you are running behind a trusted reverse proxy.

All requests use `Content-Type: application/json` unless noted. The `conversation` field is the Bot Framework conversation id (e.g. `19:aaaa@thread.v2`).

## Routes

### `GET /v1/health`

Liveness probe.

```jsonc
// 200
{ "ok": true, "ts": 1715608800000 }
```

### `POST /v1/send`

Post a plain-text message.

Body:

```jsonc
{
  "conversation": "19:...@thread.v2",
  "text": "hi"
}
```

Response: `{ "id": "1715608800000" }` (Bot Framework activity id).

Errors:

- `404 { error: "no conversation reference for <id>" }` — the bot has not seen a message in that conversation, so we don't have a `ConversationReference` to send into.
- `502 { error: "..." }` — Bot Framework REST returned an error.

### `POST /v1/embed`

Post an Adaptive Card with a title and body.

Body:

```jsonc
{
  "conversation": "19:...",
  "text": "Build passed.",
  "title": "CI",
  "color": "good"          // default | accent | good | warning | attention
}
```

### `POST /v1/buttons`

Post a card with `Action.Submit` buttons. When the user clicks, the bot receives a `message` activity with empty `text` and a `value` payload (or, for `Action.Execute`, an `invoke` with `name: "adaptiveCard/action"`). teams-cord enqueues a follow-up turn in the same Claude session with the synthesized prompt `[button-submit] key="value" ...`.

Body:

```jsonc
{
  "conversation": "19:...",
  "text": "Pick one:",
  "buttons": [
    { "label": "Yes", "id": "yes" },
    { "label": "No", "id": "no" }
  ]
}
```

### `POST /v1/file`

Upload a file via Microsoft Graph upload sessions and post a link to it.

Body:

```jsonc
{
  "conversation": "19:...",
  "filePath": "/abs/path/on/host/report.md",
  "targetPath": "/users/{userId}/drive/root:/teams-cord:",
  "name": "report.md"      // optional
}
```

Response:

```jsonc
{
  "id": "<activity id of the link message>",
  "upload": { "driveItemId": "...", "webUrl": "https://...", "size": 1234, "name": "report.md" }
}
```

### `POST /v1/typing`

Send a typing indicator.

Body: `{ "conversation": "19:..." }` -> `{ "ok": true }`

### `PATCH /v1/messages/:id`

Edit a previously sent activity.

Body: `{ "conversation": "19:...", "text": "new text" }`

The `:id` param is the activity id returned from `POST /v1/send`.

### `POST /v1/state`

Mark a message as `done | in-progress | error`. Implemented as a `PUT` activity that appends a small status suffix to the message body — Teams has no native reaction.

Body:

```jsonc
{
  "conversation": "19:...",
  "activityId": "<from POST /v1/send>",
  "state": "done",         // "done" | "in-progress" | "error"
  "text": "..."            // preserved body; the suffix is appended
}
```

### `POST /v1/config/dir`

Set (or clear) the working directory for a conversation. Stored in SQLite.

Body: `{ "conversation": "19:...", "dir": "/abs/path" }` (or `dir: null` to clear).

## Error format

All non-2xx responses use:

```jsonc
{ "error": "<human-readable message>" }
```

## TODO

- Authenticate the local API (optional shared-secret header) if exposing beyond localhost.
- Stream Claude stdout chunks via SSE for `/v1/send` consumers that want incremental updates.
