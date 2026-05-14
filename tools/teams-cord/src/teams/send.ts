import { buildUserAgent } from "./user-agent.js";
import { getBotFrameworkToken } from "./auth.js";
import type { ConversationReference, OutboundActivity, TeamsCredentials } from "./types.js";

/**
 * Adapted from extensions/msteams/src/sdk.ts (createSendContext + REST
 * helpers). OpenClaw plugin-SDK coupling (`fetchWithSsrFGuard`, plugin
 * runtime) is removed; we use plain `fetch`.
 */

function joinUrl(serviceUrl: string, path: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}${path}`;
}

function bearerHeaders(token: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": buildUserAgent(),
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

async function readErrorText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")) || "<no body>";
}

export type SendOptions = {
  creds: TeamsCredentials;
  reference: ConversationReference;
  activity: OutboundActivity;
};

export type SendResult = { id: string };

/**
 * Post a new activity to a conversation.
 * POST /v3/conversations/{conversationId}/activities
 */
export async function sendActivity({ creds, reference, activity }: SendOptions): Promise<SendResult> {
  const token = await getBotFrameworkToken(creds);
  const url = joinUrl(
    reference.serviceUrl,
    `/v3/conversations/${encodeURIComponent(reference.conversation.id)}/activities`,
  );

  const tenantId = reference.tenantId ?? reference.conversation.tenantId;
  const existingChannelData =
    activity.channelData && typeof activity.channelData === "object" ? activity.channelData : undefined;
  const channelData = tenantId
    ? { ...existingChannelData, tenant: { id: tenantId } }
    : existingChannelData;

  const body = {
    type: activity.type ?? "message",
    ...activity,
    ...(channelData ? { channelData } : {}),
    from: reference.bot?.id ? { id: reference.bot.id, name: reference.bot.name ?? "", role: "bot" } : undefined,
    conversation: {
      id: reference.conversation.id,
      conversationType: reference.conversation.conversationType ?? "personal",
      ...(tenantId ? { tenantId } : {}),
    },
    ...(reference.user?.id || reference.user?.aadObjectId
      ? {
          recipient: {
            ...(reference.user.id ? { id: reference.user.id } : {}),
            ...(reference.user.aadObjectId ? { aadObjectId: reference.user.aadObjectId } : {}),
          },
        }
      : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: bearerHeaders(token, "application/json"),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`sendActivity failed (${res.status}): ${await readErrorText(res)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: json.id ?? "unknown" };
}

/**
 * Update a previously sent activity.
 * PUT /v3/conversations/{conversationId}/activities/{activityId}
 */
export async function updateActivity(params: {
  creds: TeamsCredentials;
  reference: ConversationReference;
  activityId: string;
  activity: OutboundActivity;
}): Promise<SendResult> {
  const { creds, reference, activityId, activity } = params;
  if (!activityId) {
    throw new Error("updateActivity requires an activity id");
  }
  const token = await getBotFrameworkToken(creds);
  const url = joinUrl(
    reference.serviceUrl,
    `/v3/conversations/${encodeURIComponent(reference.conversation.id)}/activities/${encodeURIComponent(activityId)}`,
  );
  const res = await fetch(url, {
    method: "PUT",
    headers: bearerHeaders(token, "application/json"),
    body: JSON.stringify({ type: "message", ...activity, id: activityId }),
  });
  if (!res.ok) {
    throw new Error(`updateActivity failed (${res.status}): ${await readErrorText(res)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: json.id ?? activityId };
}

/**
 * Delete an activity.
 * DELETE /v3/conversations/{conversationId}/activities/{activityId}
 */
export async function deleteActivity(params: {
  creds: TeamsCredentials;
  reference: ConversationReference;
  activityId: string;
}): Promise<void> {
  const { creds, reference, activityId } = params;
  if (!activityId) {
    throw new Error("deleteActivity requires an activity id");
  }
  const token = await getBotFrameworkToken(creds);
  const url = joinUrl(
    reference.serviceUrl,
    `/v3/conversations/${encodeURIComponent(reference.conversation.id)}/activities/${encodeURIComponent(activityId)}`,
  );
  const res = await fetch(url, {
    method: "DELETE",
    headers: bearerHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`deleteActivity failed (${res.status}): ${await readErrorText(res)}`);
  }
}

export async function sendTyping(opts: { creds: TeamsCredentials; reference: ConversationReference }): Promise<void> {
  await sendActivity({
    creds: opts.creds,
    reference: opts.reference,
    activity: { type: "typing" } as OutboundActivity,
  });
}
