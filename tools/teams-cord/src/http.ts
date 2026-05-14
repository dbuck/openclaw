import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { logger } from "./log.js";
import { ThreadStore } from "./db.js";
import { sendActivity, updateActivity, sendTyping } from "./teams/send.js";
import { uploadFile } from "./teams/attachments.js";
import { getGraphToken } from "./teams/auth.js";
import type { OutboundActivity } from "./teams/types.js";
import { adaptiveCardEmbed, adaptiveCardButtons } from "./cards.js";

const log = logger("http");

export type StartedHttp = {
  app: Express;
  stop: () => Promise<void>;
};

/**
 * Local HTTP API. The cord-equivalent of `port 2643`. Default `127.0.0.1:2644`.
 * Bind to localhost only by default — there is no auth on this surface.
 */
export async function startHttp(cfg: Config = loadConfig()): Promise<StartedHttp> {
  const store = new ThreadStore(cfg.dbPath);
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  function getReferenceOr404(conversationId: string, res: Response) {
    const ref = store.getReference(conversationId);
    if (!ref) {
      res.status(404).json({ error: `no conversation reference for ${conversationId}` });
      return null;
    }
    return ref;
  }

  app.get("/v1/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.post("/v1/send", async (req: Request, res: Response) => {
    const { conversation, text } = req.body as { conversation: string; text: string };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      const out = await sendActivity({
        creds: cfg.creds,
        reference: ref,
        activity: { type: "message", text },
      });
      res.json({ id: out.id });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/embed", async (req: Request, res: Response) => {
    const { conversation, text, title, color } = req.body as {
      conversation: string;
      text: string;
      title?: string;
      color?: string;
    };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      const activity: OutboundActivity = {
        type: "message",
        attachments: [adaptiveCardEmbed({ title, text, color })],
      };
      const out = await sendActivity({ creds: cfg.creds, reference: ref, activity });
      res.json({ id: out.id });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/buttons", async (req: Request, res: Response) => {
    const { conversation, text, buttons } = req.body as {
      conversation: string;
      text: string;
      buttons: Array<{ label: string; id: string }>;
    };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      const activity: OutboundActivity = {
        type: "message",
        attachments: [adaptiveCardButtons({ text, buttons })],
      };
      const out = await sendActivity({ creds: cfg.creds, reference: ref, activity });
      res.json({ id: out.id });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/file", async (req: Request, res: Response) => {
    const { conversation, filePath, targetPath, name } = req.body as {
      conversation: string;
      filePath: string;
      /** Graph drive target, e.g. `/users/{id}/drive/root:/teams-cord:` */
      targetPath: string;
      name?: string;
    };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      const token = await getGraphToken(cfg.creds);
      const upload = await uploadFile({ token, targetPath, filePath, name });
      // Post a link back into the conversation so the user sees the file.
      const out = await sendActivity({
        creds: cfg.creds,
        reference: ref,
        activity: {
          type: "message",
          text: upload.webUrl ? `Uploaded **${upload.name}**: ${upload.webUrl}` : `Uploaded **${upload.name}**`,
        },
      });
      res.json({ id: out.id, upload });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/typing", async (req: Request, res: Response) => {
    const { conversation } = req.body as { conversation: string };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      await sendTyping({ creds: cfg.creds, reference: ref });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.patch("/v1/messages/:id", async (req: Request, res: Response) => {
    const { conversation, text } = req.body as { conversation: string; text: string };
    const activityId = req.params.id;
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    try {
      const out = await updateActivity({
        creds: cfg.creds,
        reference: ref,
        activityId,
        activity: { type: "message", text },
      });
      res.json({ id: out.id });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/state", async (req: Request, res: Response) => {
    // Teams doesn't have an exact equivalent of cord's "✅ done" reaction. We
    // approximate by appending a status suffix to the message via updateActivity.
    const { conversation, activityId, state, text } = req.body as {
      conversation: string;
      activityId: string;
      state: "done" | "in-progress" | "error";
      text?: string;
    };
    const ref = getReferenceOr404(conversation, res);
    if (!ref) return;
    const suffix = state === "done" ? "\n\n_✓ done_" : state === "error" ? "\n\n_✗ error_" : "\n\n_… in progress_";
    try {
      const out = await updateActivity({
        creds: cfg.creds,
        reference: ref,
        activityId,
        activity: { type: "message", text: (text ?? "") + suffix },
      });
      res.json({ id: out.id });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/config/dir", async (req: Request, res: Response) => {
    const { conversation, dir } = req.body as { conversation: string; dir: string | null };
    store.setWorkingDir(conversation, dir);
    res.json({ ok: true });
  });

  const server = app.listen(cfg.http.port, cfg.http.host, () =>
    log.info("http listening", { host: cfg.http.host, port: cfg.http.port }),
  );

  return {
    app,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
