import * as path from "node:path";
import { Worker } from "bullmq";
import type { Config } from "./config.js";
import { loadConfig, isPathAllowed } from "./config.js";
import { logger } from "./log.js";
import { ThreadStore } from "./db.js";
import { QUEUE_NAME, createRedis, type ClaudeJob, type ClaudeJobResult } from "./queue.js";
import { spawnClaude } from "./spawner.js";
import { sendActivity } from "./teams/send.js";

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

  const workingDir = resolveWorkingDir(cfg, store, job);
  if (!workingDir) {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: {
        type: "message",
        text: "No working directory configured. Use `/cord config dir <path>` or `[/path]` inline.",
      },
    });
    return { ok: false, error: "no working_dir" };
  }

  if (!isPathAllowed(cfg, workingDir)) {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: { type: "message", text: `Working directory \`${workingDir}\` is not on the allowlist.` },
    });
    return { ok: false, error: "working_dir not allowed" };
  }

  const resumeSessionId = store.getSession(job.conversationId) ?? undefined;
  const result = await spawnClaude({
    cfg,
    prompt: buildPrompt(job),
    workingDir,
    resumeSessionId,
  });

  if (result.sessionId && result.sessionId !== resumeSessionId) {
    store.setSession(job.conversationId, result.sessionId);
  }

  const posted = await sendActivity({
    creds: cfg.creds,
    reference,
    activity: { type: "message", text: result.text || "(Claude returned no text.)" },
  });

  return { ok: true, sessionId: result.sessionId, postedActivityId: posted.id };
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
