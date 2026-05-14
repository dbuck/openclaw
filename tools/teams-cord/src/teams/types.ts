export type TeamsCredentials = {
  appId: string;
  appPassword: string;
  tenantId: string;
};

export type Activity = {
  type: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  conversation?: {
    id: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  from?: { id?: string; name?: string; role?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string; aadObjectId?: string };
  channelData?: Record<string, unknown> & {
    tenant?: { id?: string };
    teamsChannelId?: string;
    teamsTeamId?: string;
  };
  entities?: Array<{
    type: string;
    text?: string;
    mentioned?: { id?: string; name?: string };
  }>;
  attachments?: Array<{
    contentType: string;
    contentUrl?: string;
    name?: string;
    content?: unknown;
  }>;
  replyToId?: string;
  timestamp?: string;
};

export type ConversationReference = {
  serviceUrl: string;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  bot?: { id?: string; name?: string };
  user?: { id?: string; name?: string; aadObjectId?: string };
  tenantId?: string;
};

export type OutboundActivity = {
  type?: string;
  text?: string;
  attachments?: Array<{ contentType: string; content?: unknown; contentUrl?: string; name?: string }>;
  channelData?: Record<string, unknown>;
  replyToId?: string;
};

export function activityToReference(activity: Activity): ConversationReference {
  if (!activity.serviceUrl) {
    throw new Error("Activity has no serviceUrl");
  }
  if (!activity.conversation?.id) {
    throw new Error("Activity has no conversation.id");
  }
  return {
    serviceUrl: activity.serviceUrl,
    conversation: {
      id: activity.conversation.id,
      conversationType: activity.conversation.conversationType,
      tenantId: activity.conversation.tenantId,
    },
    bot: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    user: activity.from
      ? { id: activity.from.id, name: activity.from.name, aadObjectId: activity.from.aadObjectId }
      : undefined,
    tenantId: activity.channelData?.tenant?.id ?? activity.conversation.tenantId,
  };
}
