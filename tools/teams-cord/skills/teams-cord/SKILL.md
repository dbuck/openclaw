---
name: teams-cord
summary: Drive a Microsoft Teams conversation from inside a Claude Code session.
---

# teams-cord

You are running inside a Claude Code session that was spawned by **teams-cord**, a Bot Framework bridge from Microsoft Teams to Claude Code. The user @-mentioned the bot in a Teams chat or channel; their message is your prompt.

You can talk back to the user by either:

1. **Returning text from your run.** The worker posts your final response to the same Teams conversation automatically.
2. **Calling the local HTTP API** at `http://127.0.0.1:2644` (configurable via `TEAMS_CORD_HTTP_PORT`) to post extra messages, status updates, attachments, or interactive cards mid-run.

The matching CLI is `teams-cord <subcommand>` — it's a thin wrapper over the HTTP API.

## When to use the HTTP API vs. final text

| Situation | Use |
| --- | --- |
| Short answer, one message | Just return text. The worker posts it. |
| Long-running task; want progress | `POST /v1/send` periodically with status updates. |
| Result includes a file | `POST /v1/file` (uploads via Graph, posts a link). |
| Result is rich (titled, colored) | `POST /v1/embed` with `title` + `color`. |
| Need user choice | `POST /v1/buttons` and wait for `Action.Submit`. |
| Long task, want a placeholder you'll edit | The worker already does this for your final reply (streamed via `--output-format stream-json` + debounced `updateActivity`). Only use the manual pattern for *additional* messages: `POST /v1/send`, capture the `id`, then `PATCH /v1/messages/:id`. |

## Conversation id and environment

teams-cord exports the following env vars to your subprocess:

| Variable | Meaning |
| --- | --- |
| `TEAMS_CORD_CONVERSATION_ID` | Bot Framework conversation id (`19:...@thread.v2` / `19:...@unq.gbl.spaces`). |
| `TEAMS_CORD_HTTP_URL` | Base URL of the local HTTP API (e.g. `http://127.0.0.1:2644`). |
| `TEAMS_CORD_WORKING_DIR` | The resolved working directory you were spawned in. |
| `TEAMS_CORD_FROM_USER` | Display name of the user who triggered this turn (when known). |
| `TEAMS_CORD_INBOUND_ACTIVITY_ID` | Activity id of the inbound Teams message (use for reply threading). |

```sh
echo "$TEAMS_CORD_CONVERSATION_ID"  # e.g. 19:aaaa@thread.v2
```

If you ever need to talk to a different conversation, the bot must already have seen activity there (so we have a stored `ConversationReference`).

## Streaming

The worker streams your stdout (`--output-format stream-json`) and posts assistant text to Teams as it arrives, editing a single message in place. You don't need to call `/v1/send` for every chunk — just emit text from your run and the worker handles the placeholder + debounced `updateActivity` calls. Use `/v1/send` for *additional* messages (status pings, separate replies), not for incremental rendering of your main answer.

The current implementation uses plain `updateActivity` edits (debounced to 1500 ms). Each update will render with an "Edited" badge rather than as Teams' native streaming UX, which requires the first-class `streaminfo` protocol (`streamType: streaming/final`, `streamId`, `streamSequence`) — that promotion is on the open TODO list.

## Button submissions

When the user clicks an `Action.Submit` button on a card you posted via `/v1/buttons`, teams-cord enqueues a follow-up turn in the same Claude session with a synthesized prompt of the form:

```
[button-submit] id="yes"
```

You will see this as the user's next message. Treat it as the user's response to the choice you offered. The same `TEAMS_CORD_INBOUND_ACTIVITY_ID` env var will reference the invoke/message activity for the click.

## CLI examples

```sh
teams-cord send "$TEAMS_CORD_CONVERSATION_ID" "Working on it — should take ~30s"
teams-cord embed "$TEAMS_CORD_CONVERSATION_ID" "Build summary: 4 tests passing" \
  --title "Build done" --color good
teams-cord file "$TEAMS_CORD_CONVERSATION_ID" ./report.md \
  --target "/users/<userId>/drive/root:/teams-cord:" --name report.md
teams-cord typing "$TEAMS_CORD_CONVERSATION_ID"
teams-cord edit "$TEAMS_CORD_CONVERSATION_ID" "$MSG_ID" "Updated text"
teams-cord state "$TEAMS_CORD_CONVERSATION_ID" "$MSG_ID" done --text "Original text"
```

## HTTP examples

```sh
curl -s -X POST http://127.0.0.1:2644/v1/send \
  -H 'Content-Type: application/json' \
  -d "{\"conversation\":\"$TEAMS_CORD_CONVERSATION_ID\",\"text\":\"hi from claude\"}"
```

For the full route reference, see `HTTP-API.md` in this directory.

## Hard rules

- **Never** include secrets (tokens, env values, passwords) in messages you post to Teams. Treat anything you post as visible to every member of the chat.
- **Never** edit a message you didn't send — the API will let you, but it confuses the user.
- **Do** post a short ack (`typing` or a one-line `send`) within the first ~3s if you expect to take a while; the user can't tell whether the bot is working otherwise.
- **Do** include the `id` returned by `/v1/send` if you plan to `PATCH /v1/messages/:id` later.

## Limitations

- Adaptive Cards only — no Discord-style embeds. teams-cord's `embed` is a small AdaptiveCard with a title + body.
- File uploads require a Graph drive target path (`--target`). The user can configure a default with `teams-cord config dir`.
- There is no native "reaction" in Teams; the `state` command updates the message text with a small `_✓ done_` suffix.
