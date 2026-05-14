import { buildUserAgent } from "./user-agent.js";

/**
 * Minimal Microsoft Graph client adapted from
 * extensions/msteams/src/graph.ts. The OpenClaw plugin-SDK helpers
 * (`fetchWithSsrFGuard`, runtime config) are replaced with plain `fetch`.
 */

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

async function requestGraph(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Response> {
  const hasBody = params.body !== undefined;
  const url = params.path.startsWith("http") ? params.path : `${GRAPH_ROOT}${params.path}`;
  const res = await fetch(url, {
    method: params.method ?? "GET",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...params.headers,
    },
    body: hasBody ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${params.method ?? "GET"} ${params.path} failed (${res.status}): ${text || "<no body>"}`);
  }
  return res;
}

async function readOptionalJson<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function graphGet<T>(token: string, path: string): Promise<T> {
  const res = await requestGraph({ token, path, method: "GET" });
  return readOptionalJson<T>(res);
}

export async function graphPost<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await requestGraph({ token, path, method: "POST", body });
  return readOptionalJson<T>(res);
}

export async function graphPatch<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await requestGraph({ token, path, method: "PATCH", body });
  return readOptionalJson<T>(res);
}

export async function graphDelete(token: string, path: string): Promise<void> {
  await requestGraph({ token, path, method: "DELETE" });
}

type Paged<T> = { value?: T[]; "@odata.nextLink"?: string };

export async function graphList<T>(params: {
  token: string;
  path: string;
  maxPages?: number;
}): Promise<T[]> {
  const maxPages = params.maxPages ?? 50;
  const items: T[] = [];
  let next: string | undefined = params.path;
  for (let i = 0; i < maxPages && next; i++) {
    const page = await graphGet<Paged<T>>(params.token, next);
    if (page?.value) items.push(...page.value);
    const link = page?.["@odata.nextLink"];
    next = link
      ? link.replace("https://graph.microsoft.com/v1.0", "").replace("https://graph.microsoft.com/beta", "")
      : undefined;
  }
  return items;
}
