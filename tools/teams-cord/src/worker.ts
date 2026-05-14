import * as path from "node:path";
import { Worker } from "bullmq";
import type { Config } from "./config.js";
import { loadConfig, isPathAllowed } from "./config.js";
import { logger } from "./log.js";
import { ThreadStore } from "./db.js";
import { QUEUE_NAME, createRedis, type ClaudeJob, type ClaudeJobResult } from "./queue.js";
import { spawnClaude, type ClaudeEvent } from "./spawner.js";
import { StreamingTeamsMessage } from "./streaming-message.js";
import { sendActivity } from "./teams/send.js";
import { buildOutboundMentions, type OutboundMention } from "./teams/mentions.js";
import type { OutboundActivity } from "./teams/types.js";

const log = logger("worker");

export function startWorker(cfg: Config = loadConfig()): Worker<ClaudeJob, ClaudeJobResult> {
  const store = new ThreadStore(cfg.dbPath);
  const connection = createRedis(cfg);

  const worker = new Worker<ClaudeJob, ClaudeJobResult>(
    QUEUE_NAME,
    async (job) => processJob(job.data, cfg, store),
    { connection, concurrency: 1 },
  );

  worker.on("ready", () => log.info("worker ready", { queue: QUEUE_NAME }));
  worker.on("failed", (job, err) => log.error("job failed", { id: job?.id, err: err.message }));
  worker.on("completed", (job) => log.debug("job completed", { id: job.id }));

  return worker;
}

async function processJob(
  job: ClaudeJob,
  cfg: Config,
  store: ThreadStore,
): Promise<ClaudeJobResult> {
  const reference = store.getReference(job.conversationId);
  if (!reference) {
    return { ok: false, error: `No conversation reference stored for ${job.conversationId}` };
  }

  const replyMentions: OutboundMention[] = job.replyMention
    ? [job.replyMention]
    : reference.user?.id && reference.user.name
      ? [{ userId: reference.user.id, name: reference.user.name }]
      : [];

  const buildActivity = (text: string): OutboundActivity => {
    const decoration = buildOutboundMentions(replyMentions);
    return {
      type: "message",
      text: decoration.textPrefix + text,
      entities: decoration.entities.length > 0 ? decoration.entities : undefined,
    };
  };

  const workingDir = resolveWorkingDir(cfg, store, job);
  if (!workingDir) {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: buildActivity(
        "No working directory configured. Use `teams-cord config dir <path>` or `[/path]` inline.",
      ),
    });
    return { ok: false, error: "no working_dir" };
  }

  if (!isPathAllowed(cfg, workingDir)) {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: buildActivity(`Working directory \`${workingDir}\` is not on the allowlist.`),
    });
    return { ok: false, error: "working_dir not allowed" };
  }

  const resumeSessionId = store.getSession(job.conversationId) ?? undefined;
  const stream = new StreamingTeamsMessage({
    creds: cfg.creds,
    reference,
    buildActivity,
  });

  const extraEnv = buildSpawnEnv(cfg, job, workingDir);
  const onEvent = (event: ClaudeEvent) => handleEvent(event, stream);

  let result;
  try {
    result = await spawnClaude({
      cfg,
      prompt: buildPrompt(job),
      workingDir,
      resumeSessionId,
      extraEnv,
      onEvent,
    });
  } catch (err) {
    log.error("spawn failed", { err: (err as Error).message });
    await stream.finalize(`Error spawning claude: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }

  if (result.sessionId && result.sessionId !== resumeSessionId) {
    store.setSession(job.conversationId, result.sessionId);
  }

  const finalText = result.text || (result.isError ? "(Claude reported an error.)" : "(Claude returned no text.)");
  const postedActivityId = await stream.finalize(finalText);

  return {
    ok: !result.isError && result.exitCode === 0,
    sessionId: result.sessionId,
    postedActivityId: postedActivityId ?? undefined,
    error: result.isError ? "claude reported is_error" : undefined,
  };
}

function handleEvent(event: ClaudeEvent, stream: StreamingTeamsMessage): void {
  if (event.type !== "assistant") return;
  const message = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
  if (!message?.content) return;
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      // Fire-and-forget; the streamer handles its own ordering.
      stream.appendText(block.text).catch((err) => log.warn("appendText failed", { err: err.message }));
    }
  }
}

function buildSpawnEnv(cfg: Config, job: ClaudeJob, workingDir: string): Record<string, string> {
  return {
    TEAMS_CORD_CONVERSATION_ID: job.conversationId,
    TEAMS_CORD_HTTP_URL: `http://${cfg.http.host}:${cfg.http.port}`,
    TEAMS_CORD_WORKING_DIR: workingDir,
    ...(job.fromUser ? { TEAMS_CORD_FROM_USER: job.fromUser } : {}),
    ...(job.inboundActivityId ? { TEAMS_CORD_INBOUND_ACTIVITY_ID: job.inboundActivityId } : {}),
  };
}

function resolveWorkingDir(cfg: Config, store: ThreadStore, job: ClaudeJob): string | null {
  if (job.workingDirOverride) return path.resolve(job.workingDirOverride);
  const perThread = store.getWorkingDir(job.conversationId);
  if (perThread) return path.resolve(perThread);
  if (cfg.claude.defaultWorkingDir) return path.resolve(cfg.claude.defaultWorkingDir);
  return null;
}

function buildPrompt(job: ClaudeJob): string {
  const from = job.fromUser ? `${job.fromUser}: ` : "";
  return `${from}${job.prompt}`;
}
