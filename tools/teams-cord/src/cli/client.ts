import { loadConfig } from "../config.js";

/**
 * Thin HTTP client that calls the local teams-cord HTTP API. The CLI uses
 * this to drive the running bot/worker process — same shape as cord's CLI
 * subcommands.
 */

function baseUrl(): string {
  const cfg = loadConfig();
  return `http://${cfg.http.host}:${cfg.http.port}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PATCH ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

export const client = {
  send: (conversation: string, text: string) =>
    postJson<{ id: string }>("/v1/send", { conversation, text }),
  embed: (conversation: string, text: string, opts: { title?: string; color?: string }) =>
    postJson<{ id: string }>("/v1/embed", { conversation, text, ...opts }),
  file: (conversation: string, filePath: string, targetPath: string, name?: string) =>
    postJson<{ id: string; upload: { webUrl?: string; name: string } }>("/v1/file", {
      conversation,
      filePath,
      targetPath,
      name,
    }),
  typing: (conversation: string) => postJson<{ ok: true }>("/v1/typing", { conversation }),
  edit: (conversation: string, activityId: string, text: string) =>
    patchJson<{ id: string }>(`/v1/messages/${encodeURIComponent(activityId)}`, { conversation, text }),
  state: (
    conversation: string,
    activityId: string,
    state: "done" | "in-progress" | "error",
    text?: string,
  ) => postJson<{ id: string }>("/v1/state", { conversation, activityId, state, text }),
  buttons: (
    conversation: string,
    text: string,
    buttons: Array<{ label: string; id: string }>,
  ) => postJson<{ id: string }>("/v1/buttons", { conversation, text, buttons }),
  health: () => getJson<{ ok: boolean; ts: number }>("/v1/health"),
  configDir: (conversation: string, dir: string | null) =>
    postJson<{ ok: true }>("/v1/config/dir", { conversation, dir }),
};
