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
