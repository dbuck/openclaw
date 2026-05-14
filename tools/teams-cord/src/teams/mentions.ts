import type { Activity } from "./types.js";

export type MentionInfo = {
  /** The bot's user id within the conversation (e.g. 28:...). */
  botId: string;
  /** Cleaned text with the @bot mention stripped. */
  cleanText: string;
  /** Optional inline `[/working/dir]` override extracted from the message. */
  workingDirOverride?: string;
};

/**
 * Detect an @bot mention and strip it (plus an optional `[/path]`
 * working-dir hint) from the message text. Adapted from
 * extensions/msteams/src/mentions.ts.
 */
export function extractBotMention(activity: Activity, botAppId: string): MentionInfo | null {
  const text = (activity.text ?? "").trim();
  const entities = activity.entities ?? [];

  const mention = entities.find(
    (e) => e.type?.toLowerCase() === "mention" && e.mentioned?.id?.includes(botAppId),
  );
  if (!mention) return null;

  let cleaned = text;
  if (mention.text) {
    cleaned = cleaned.replace(mention.text, "").trim();
  }
  // Strip stray HTML mention markup that some clients leave behind.
  cleaned = cleaned.replace(/<at>[^<]*<\/at>/gi, "").trim();

  let workingDirOverride: string | undefined;
  const dirMatch = cleaned.match(/^\[(\/[^\]]+)\]\s*/);
  if (dirMatch) {
    workingDirOverride = dirMatch[1];
    cleaned = cleaned.slice(dirMatch[0].length).trim();
  }

  return {
    botId: mention.mentioned?.id ?? botAppId,
    cleanText: cleaned,
    workingDirOverride,
  };
}

export type OutboundMention = {
  /** Teams user id of the person being mentioned (typically `29:...` or AAD object id). */
  userId: string;
  /** Display name to render inside the `<at>...</at>` markup. */
  name: string;
};

export type MentionDecoration = {
  /** Prefix to prepend to the message body so the @-pill renders. */
  textPrefix: string;
  /** Entities to attach to the outbound activity. */
  entities: Array<{ type: "mention"; text: string; mentioned: { id: string; name: string } }>;
};

/**
 * Build the `text` prefix and `entities` array required for Teams to render
 * an @-mention pill on an outbound message. Teams won't render a pill unless
 * the message text contains the exact `<at>display</at>` literal and there
 * is a matching `mention` entity for it.
 */
export function buildOutboundMentions(mentions: OutboundMention[]): MentionDecoration {
  if (mentions.length === 0) return { textPrefix: "", entities: [] };
  const parts: string[] = [];
  const entities = mentions.map((m) => {
    const safeName = escapeForMentionText(m.name);
    const tag = `<at>${safeName}</at>`;
    parts.push(tag);
    return {
      type: "mention" as const,
      text: tag,
      mentioned: { id: m.userId, name: m.name },
    };
  });
  return { textPrefix: `${parts.join(" ")} `, entities };
}

function escapeForMentionText(name: string): string {
  // Teams accepts most characters inside <at>, but raw `<`/`>` would break
  // the tag boundary. Strip them defensively; the resulting display name
  // still resolves to the AAD identity in `mentioned.id`.
  return name.replace(/[<>]/g, "").trim() || "user";
}
