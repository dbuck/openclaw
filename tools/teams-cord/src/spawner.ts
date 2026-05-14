import { spawn } from "node:child_process";
import { logger } from "./log.js";
import type { Config } from "./config.js";

const log = logger("spawner");

export type SpawnOptions = {
  cfg: Config;
  prompt: string;
  workingDir: string;
  resumeSessionId?: string;
};

export type SpawnResult = {
  /** Stdout text from the Claude run (the assistant's final reply). */
  text: string;
  /** Session id (resolved from final assistant message or `--print-session-id`). */
  sessionId?: string;
  /** Exit code. */
  exitCode: number;
};

/**
 * Spawn the `claude` CLI as a subprocess. Mirrors cord's spawner.ts: pipe the
 * prompt on stdin, request JSON output, capture the final assistant message.
 *
 * TODO: chunked streaming. Right now we wait for the run to complete and post
 * the whole reply at once; for long-running tasks we want to stream
 * intermediate text into Teams as it arrives (see Claude Code's
 * `--output-format=stream-json`).
 */
export function spawnClaude(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const args = ["--print", "--output-format", "json"];
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    log.info("spawning claude", { workingDir: opts.workingDir, resume: opts.resumeSessionId });
    const child = spawn(opts.cfg.claude.bin, args, {
      cwd: opts.workingDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
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
      const parsed = parseClaudeOutput(stdout);
      resolve({ text: parsed.text, sessionId: parsed.sessionId, exitCode });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

function parseClaudeOutput(raw: string): { text: string; sessionId?: string } {
  // `claude --print --output-format json` emits a single JSON object on stdout
  // with `result` (final assistant text) and `session_id`. Fall back to raw
  // stdout if parsing fails so we still post something to Teams.
  try {
    const json = JSON.parse(raw) as { result?: string; session_id?: string };
    return { text: json.result ?? raw, sessionId: json.session_id };
  } catch {
    return { text: raw };
  }
}
