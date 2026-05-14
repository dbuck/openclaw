import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { logger } from "./log.js";
import { ThreadStore } from "./db.js";
import { createQueue, type ClaudeJob } from "./queue.js";
import { createBotJwtValidator } from "./teams/jwt.js";
import { activityToReference, type Activity } from "./teams/types.js";
import { extractBotMention } from "./teams/mentions.js";
import { sendActivity } from "./teams/send.js";

const log = logger("bot");

export type StartedBot = {
  app: Express;
  stop: () => Promise<void>;
};

/**
 * Start the Bot Framework webhook listener. Adapted from
 * extensions/msteams/src/inbound.ts but stripped of the OpenClaw plugin
 * runtime and gateway routing — we just queue Claude jobs.
 */
export async function startBot(cfg: Config = loadConfig()): Promise<StartedBot> {
  const store = new ThreadStore(cfg.dbPath);
  const queue = createQueue(cfg);
  const validate = createBotJwtValidator(cfg.creds);

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post(cfg.webhook.path, async (req: Request, res: Response) => {
    const auth = (req.headers.authorization ?? req.headers.Authorization) as string | undefined;
    if (!auth) {
      res.status(401).send("missing authorization header");
      return;
    }
    let ok = false;
    try {
      ok = await validate(auth);
    } catch (err) {
      log.warn("JWT validation network error", { err: (err as Error).message });
      res.status(503).send("auth provider unreachable");
      return;
    }
    if (!ok) {
      res.status(401).send("invalid token");
      return;
    }

    const activity = req.body as Activity;
    res.status(200).send(); // Ack immediately; do work asynchronously.

    try {
      await handleActivity(activity, cfg, store, queue);
    } catch (err) {
      log.error("handleActivity error", { err: (err as Error).message });
    }
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const server = app.listen(cfg.webhook.port, () =>
    log.info("bot listening", { port: cfg.webhook.port, path: cfg.webhook.path }),
  );

  return {
    app,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue.close();
      store.close();
    },
  };
}

async function handleActivity(
  activity: Activity,
  cfg: Config,
  store: ThreadStore,
  queue: ReturnType<typeof createQueue>,
): Promise<void> {
  if (activity.type !== "message") {
    log.debug("ignoring non-message activity", { type: activity.type });
    return;
  }

  const reference = activityToReference(activity);
  store.upsertReference(reference);

  const mention = extractBotMention(activity, cfg.creds.appId);
  if (!mention) {
    log.debug("no bot mention; ignoring");
    return;
  }
  if (!mention.cleanText.trim()) {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: { type: "message", text: "How can I help? Add a prompt after the @mention." },
    });
    return;
  }

  const job: ClaudeJob = {
    conversationId: reference.conversation.id,
    prompt: mention.cleanText,
    workingDirOverride: mention.workingDirOverride,
    fromUser: activity.from?.name,
    inboundActivityId: activity.id,
  };

  await queue.add("claude", job, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  // Acknowledge in-thread so the user knows we got it (typing indicator).
  try {
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: { type: "typing" },
    });
  } catch (err) {
    log.warn("typing send failed", { err: (err as Error).message });
  }
}
