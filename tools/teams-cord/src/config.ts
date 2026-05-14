import "dotenv/config";
import type { TeamsCredentials } from "./teams/types.js";

export type Config = {
  creds: TeamsCredentials;
  redis: { host: string; port: number; password?: string };
  dbPath: string;
  webhook: { port: number; path: string };
  http: { host: string; port: number };
  claude: { bin: string; defaultWorkingDir?: string };
  allowedDirs: string[];
  logLevel: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    creds: {
      appId: required("TEAMS_APP_ID"),
      appPassword: required("TEAMS_APP_PASSWORD"),
      tenantId: required("TEAMS_TENANT_ID"),
    },
    redis: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: int("REDIS_PORT", 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    dbPath: process.env.DB_PATH ?? "./data/threads.db",
    webhook: {
      port: int("TEAMS_WEBHOOK_PORT", 3978),
      path: process.env.TEAMS_WEBHOOK_PATH ?? "/api/messages",
    },
    http: {
      host: process.env.TEAMS_CORD_HTTP_HOST ?? "127.0.0.1",
      port: int("TEAMS_CORD_HTTP_PORT", 2644),
    },
    claude: {
      bin: process.env.CLAUDE_BIN ?? "claude",
      defaultWorkingDir: process.env.CLAUDE_WORKING_DIR || undefined,
    },
    allowedDirs: (process.env.TEAMS_CORD_ALLOWED_DIRS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
  return cached;
}

export function isPathAllowed(cfg: Config, abs: string): boolean {
  if (cfg.allowedDirs.length === 0) return true; // dev-mode: no allowlist
  return cfg.allowedDirs.some((root) => abs === root || abs.startsWith(`${root}/`));
}
