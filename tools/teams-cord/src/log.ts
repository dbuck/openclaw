type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as Level[]).includes(raw as Level) ? (raw as Level) : "info";
}

function emit(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
  if (RANK[level] < RANK[currentLevel()]) return;
  const ts = new Date().toISOString();
  const line = { ts, level, scope, msg, ...meta };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
}

export function logger(scope: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", scope, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => emit("info", scope, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", scope, msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => emit("error", scope, msg, meta),
  };
}
