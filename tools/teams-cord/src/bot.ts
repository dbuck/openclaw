import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { logger } from "./log.js";
import { ThreadStore } from "./db.js";
import { createQueue, type ClaudeJob } from "./queue.js";
import { createBotJwtValidator } from "./teams/jwt.js";
import { activityToReference, type Activity } from "./teams/types.js";
import {
  buildOutboundMentions,
  extractBotMention,
  type OutboundMention,
} from "./teams/mentions.js";
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
    const auth = (req.headers.authorization ?? "") as string;
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
    if (activity?.type === "invoke") {
      // For Adaptive Card Action.Execute (`name: "adaptiveCard/action"`) the
      // client expects a structured invoke response so the card refresh
      // completes. Other invoke names (signin, file consent, messaging
      // extensions) need their own response shapes — until those are
      // implemented, ack with a bare 200 so we don't return a misleading
      // adaptive-card response for an unrelated invoke.
      if (getInvokeName(activity) === "adaptiveCard/action") {
        res.status(200).json({
          statusCode: 200,
          type: "application/vnd.microsoft.activity.message",
          value: {},
        });
      } else {
        res.status(200).send();
      }
    } else {
      res.status(200).send();
    }

    try {
      await handleActivity(activity, cfg, store, queue);
    } catch (err) {
      log.error("handleActivity error", { err: (err as Error).message });
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

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
  const reference = activityToReference(activity);
  store.upsertReference(reference);

  if (activity.type === "message") {
    const buttonPrompt = extractButtonSubmissionPrompt(activity);
    if (buttonPrompt) {
      await enqueueButtonSubmission(activity, reference, buttonPrompt, cfg, queue);
      return;
    }
    await handleMentionMessage(activity, reference, cfg, store, queue);
    return;
  }

  if (activity.type === "invoke") {
    const invokePrompt = extractAdaptiveInvokePrompt(activity);
    if (invokePrompt) {
      await enqueueButtonSubmission(activity, reference, invokePrompt, cfg, queue);
      return;
    }
    log.debug("ignoring invoke without adaptive action payload", { name: getInvokeName(activity) });
    return;
  }

  log.debug("ignoring non-actionable activity", { type: activity.type });
}

async function handleMentionMessage(
  activity: Activity,
  reference: ReturnType<typeof activityToReference>,
  cfg: Config,
  store: ThreadStore,
  queue: ReturnType<typeof createQueue>,
): Promise<void> {
  const mention = extractBotMention(activity, cfg.creds.appId);
  if (!mention) {
    log.debug("no bot mention; ignoring");
    return;
  }
  const replyMention = mentionForFrom(activity);
  if (!mention.cleanText.trim()) {
    const decoration = buildOutboundMentions(replyMention ? [replyMention] : []);
    await sendActivity({
      creds: cfg.creds,
      reference,
      activity: {
        type: "message",
        text: `${decoration.textPrefix}How can I help? Add a prompt after the @mention.`,
        entities: decoration.entities.length > 0 ? decoration.entities : undefined,
      },
    });
    return;
  }

  const job: ClaudeJob = {
    conversationId: reference.conversation.id,
    prompt: mention.cleanText,
    workingDirOverride: mention.workingDirOverride,
    fromUser: activity.from?.name,
    inboundActivityId: activity.id,
    replyMention,
  };

  await queue.add("claude", job, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  try {
    await sendActivity({ creds: cfg.creds, reference, activity: { type: "typing" } });
  } catch (err) {
    log.warn("typing send failed", { err: (err as Error).message });
  }
}

async function enqueueButtonSubmission(
  activity: Activity,
  reference: ReturnType<typeof activityToReference>,
  prompt: string,
  cfg: Config,
  queue: ReturnType<typeof createQueue>,
): Promise<void> {
  log.info("button submission", { conversationId: reference.conversation.id, prompt });
  const job: ClaudeJob = {
    conversationId: reference.conversation.id,
    prompt,
    fromUser: activity.from?.name,
    inboundActivityId: activity.id,
    replyMention: mentionForFrom(activity),
  };
  await queue.add("claude", job, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

/**
 * For Adaptive Card `Action.Submit` clicks the bot receives a regular
 * `message` activity with empty `text` and a `value` object containing the
 * submit payload. We synthesize a follow-up prompt from the payload so the
 * next Claude turn can reason about what the user clicked.
 */
function extractButtonSubmissionPrompt(activity: Activity): string | null {
  const value = (activity as Activity & { value?: unknown }).value;
  if (!isRecord(value)) return null;
  return formatSubmission(value);
}

/**
 * For Adaptive Card `Action.Execute` clicks the bot receives an `invoke`
 * activity with `name: "adaptiveCard/action"` and `value.action.data` as the
 * submit payload.
 */
function extractAdaptiveInvokePrompt(activity: Activity): string | null {
  if (getInvokeName(activity) !== "adaptiveCard/action") return null;
  const value = (activity as Activity & { value?: unknown }).value;
  if (!isRecord(value)) return null;
  const action = isRecord(value.action) ? value.action : undefined;
  const data = action && isRecord(action.data) ? action.data : value;
  return formatSubmission(data);
}

function getInvokeName(activity: Activity): string | undefined {
  return (activity as Activity & { name?: unknown }).name as string | undefined;
}

function formatSubmission(data: Record<string, unknown>): string {
  const pretty = Object.entries(data)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `[button-submit] ${pretty}`;
}

function mentionForFrom(activity: Activity): OutboundMention | undefined {
  const id = activity.from?.id;
  const name = activity.from?.name;
  if (!id || !name) return undefined;
  return { userId: id, name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
