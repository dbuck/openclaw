import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { Config } from "./config.js";

export const QUEUE_NAME = "teams-cord:claude";

export type ClaudeJob = {
  conversationId: string;
  /** Prompt text after the @-mention is stripped. */
  prompt: string;
  /** Optional inline working directory override. */
  workingDirOverride?: string;
  /** The user's display name (for prompt context). */
  fromUser?: string;
  /** Activity id for the inbound message (used for reply threading). */
  inboundActivityId?: string;
};

export type ClaudeJobResult = {
  ok: boolean;
  sessionId?: string;
  postedActivityId?: string;
  error?: string;
};

export function createRedis(cfg: Config): IORedis {
  return new IORedis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password,
    maxRetriesPerRequest: null,
  });
}

export function createQueue(cfg: Config): Queue<ClaudeJob, ClaudeJobResult> {
  return new Queue<ClaudeJob, ClaudeJobResult>(QUEUE_NAME, { connection: createRedis(cfg) });
}
