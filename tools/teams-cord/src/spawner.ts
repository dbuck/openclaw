import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { logger } from "./log.js";
import type { Config } from "./config.js";

const log = logger("spawner");

/**
 * Events emitted by `claude --output-format stream-json`. Field shapes are
 * intentionally permissive — Claude Code's stream-json schema is documented
 * as `{type, ...}` line-delimited JSON, but the inner content tree drifts
 * across CLI versions. We only depend on the fields we extract.
 */
export type ClaudeEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | {
      type: "assistant";
      session_id?: string;
      message?: {
        content?: Array<{ type: string; text?: string }>;
      };
    }
  | { type: "user"; session_id?: string }
  | {
      type: "result";
      subtype?: string;
      is_error?: boolean;
      result?: string;
      session_id?: string;
    }
  | { type: string; [k: string]: unknown };

export type SpawnOptions = {
  cfg: Config;
  prompt: string;
  workingDir: string;
  resumeSessionId?: string;
  /** Extra env vars merged on top of `process.env`. */
  extraEnv?: Record<string, string>;
  /** Called for every parsed stream-json event. */
  onEvent?: (event: ClaudeEvent) => void;
};

export type SpawnResult = {
  /** Final assistant text from the `result` event (or the accumulated assistant text). */
  text: string;
  /** Session id resolved from any event that carried one. */
  sessionId?: string;
  /** Exit code. */
  exitCode: number;
  /** True if the `result` event reported `is_error: true`. */
  isError: boolean;
};

/**
 * Spawn the `claude` CLI as a subprocess in streaming mode.
 *
 * We use `--output-format stream-json` so that incremental assistant text can
 * be forwarded to Teams while the run is still in flight. The `onEvent`
 * callback fires for every NDJSON line; the returned Promise resolves with
 * the final result once the child exits.
 */
export function spawnClaude(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    log.info("spawning claude", { workingDir: opts.workingDir, resume: opts.resumeSessionId });
    const child = spawn(opts.cfg.claude.bin, args, {
      cwd: opts.workingDir,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const accumulator = new TextAccumulator();
    let sessionId: string | undefined;
    let resultText: string | undefined;
    let isError = false;
    let stderr = "";

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: ClaudeEvent;
      try {
        event = JSON.parse(trimmed) as ClaudeEvent;
      } catch {
        log.warn("non-JSON stream line", { sample: trimmed.slice(0, 200) });
        return;
      }
      if (typeof event.session_id === "string" && !sessionId) {
        sessionId = event.session_id;
      }
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            accumulator.append(block.text);
          }
        }
      } else if (event.type === "result") {
        if (typeof event.result === "string") resultText = event.result;
        if (event.is_error) isError = true;
      }
      try {
        opts.onEvent?.(event);
      } catch (cbErr) {
        log.warn("onEvent threw", { err: (cbErr as Error).message });
      }
    });

    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        log.error("claude exited non-zero", { exitCode, stderr: stderr.slice(0, 4000) });
      }
      const text = resultText ?? accumulator.text();
      resolve({ text, sessionId, exitCode, isError });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

class TextAccumulator {
  private buf = "";
  append(chunk: string): void {
    this.buf += chunk;
  }
  text(): string {
    return this.buf;
  }
}
