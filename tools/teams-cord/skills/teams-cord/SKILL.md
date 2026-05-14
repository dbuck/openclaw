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
| Long task, want a placeholder you'll edit | First `POST /v1/send`, capture the `id`, then `PATCH /v1/messages/:id`. |

## Conversation id

Every API call needs the Bot Framework conversation id — the `19:...@thread.v2` / `19:...@unq.gbl.spaces` string. teams-cord exports it to your environment as `TEAMS_CORD_CONVERSATION_ID` when it spawns you.

```sh
echo "$TEAMS_CORD_CONVERSATION_ID"  # e.g. 19:aaaa@thread.v2
```

If you ever need to talk to a different conversation, you must already have a stored conversation reference (e.g. the user has @-mentioned the bot there at least once).

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
