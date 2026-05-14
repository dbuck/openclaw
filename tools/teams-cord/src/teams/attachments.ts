import * as fs from "node:fs";
import * as path from "node:path";
import { buildUserAgent } from "./user-agent.js";
import { graphPost } from "./graph.js";

/**
 * Skeleton port of extensions/msteams/src/attachments.ts. Implements the
 * upload-session flow against Microsoft Graph for OneDrive-backed
 * attachments.
 *
 * TODO: hook into the Teams `1:1 file consent` flow for personal scope and
 * the channel `tabs/files` upload flow for teams scope. The msteams plugin
 * has both — port them as needed.
 */

export type UploadResult = {
  /** Microsoft Graph driveItem id for the uploaded file. */
  driveItemId?: string;
  /** Public sharing URL (Graph `webUrl`) for the uploaded file. */
  webUrl?: string;
  /** Size in bytes. */
  size: number;
  /** File name as uploaded. */
  name: string;
};

type UploadSession = {
  uploadUrl?: string;
  expirationDateTime?: string;
};

const CHUNK = 5 * 1024 * 1024; // 5 MiB — Graph requires a multiple of 320 KiB; 5 MiB works.

/**
 * Upload a local file to a Graph drive folder using upload sessions.
 *
 * `targetPath` is a Graph drive path like
 * `/users/{userId}/drive/root:/Documents/teams-cord:`
 * or
 * `/groups/{teamId}/drive/root:/General/teams-cord:`.
 */
export async function uploadFile(params: {
  token: string;
  targetPath: string;
  filePath: string;
  name?: string;
}): Promise<UploadResult> {
  const { token, targetPath, filePath } = params;
  const name = params.name ?? path.basename(filePath);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`attachments.uploadFile: not a regular file: ${filePath}`);
  }

  const session = await graphPost<UploadSession>(
    token,
    `${targetPath}/${encodeURIComponent(name)}:/createUploadSession`,
    {
      item: { "@microsoft.graph.conflictBehavior": "replace", name },
    },
  );
  if (!session?.uploadUrl) {
    throw new Error("Graph did not return an uploadUrl for the upload session");
  }

  const fd = await fs.promises.open(filePath, "r");
  let finalItem: { id?: string; webUrl?: string } | undefined;
  try {
    for (let offset = 0; offset < stat.size; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, stat.size) - 1;
      const buffer = Buffer.alloc(end - offset + 1);
      await fd.read(buffer, 0, buffer.length, offset);
      const res = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "User-Agent": buildUserAgent(),
          "Content-Length": String(buffer.length),
          "Content-Range": `bytes ${offset}-${end}/${stat.size}`,
        },
        body: buffer,
      });
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => "");
        throw new Error(`Upload chunk failed (${res.status}): ${text}`);
      }
      if (res.status === 200 || res.status === 201) {
        finalItem = (await res.json().catch(() => ({}))) as { id?: string; webUrl?: string };
      }
    }
  } finally {
    await fd.close();
  }

  return {
    driveItemId: finalItem?.id,
    webUrl: finalItem?.webUrl,
    size: stat.size,
    name,
  };
}
