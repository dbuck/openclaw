/**
 * Minimal Adaptive Card builders. Teams renders Adaptive Cards (`schema.org`
 * payload type `application/vnd.microsoft.card.adaptive`) where Discord
 * would use embeds. Keep this intentionally small; richer card layouts
 * belong in a dedicated `cards/` module if/when needed.
 */

const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

function colorToken(color?: string): "default" | "accent" | "good" | "warning" | "attention" {
  switch ((color ?? "").toLowerCase()) {
    case "green":
    case "good":
      return "good";
    case "yellow":
    case "orange":
    case "warning":
      return "warning";
    case "red":
    case "error":
    case "attention":
      return "attention";
    case "blue":
    case "accent":
      return "accent";
    default:
      return "default";
  }
}

export function adaptiveCardEmbed(params: { title?: string; text: string; color?: string }): {
  contentType: string;
  content: unknown;
} {
  const body: unknown[] = [];
  if (params.title) {
    body.push({
      type: "TextBlock",
      text: params.title,
      weight: "bolder",
      size: "medium",
      color: colorToken(params.color),
      wrap: true,
    });
  }
  body.push({ type: "TextBlock", text: params.text, wrap: true });
  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: { type: "AdaptiveCard", $schema: SCHEMA, version: "1.5", body },
  };
}

export function adaptiveCardButtons(params: {
  text: string;
  buttons: Array<{ label: string; id: string; url?: string }>;
}): { contentType: string; content: unknown } {
  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      type: "AdaptiveCard",
      $schema: SCHEMA,
      version: "1.5",
      body: [{ type: "TextBlock", text: params.text, wrap: true }],
      actions: params.buttons.map((b) =>
        b.url
          ? { type: "Action.OpenUrl", title: b.label, url: b.url }
          : { type: "Action.Submit", title: b.label, data: { id: b.id } },
      ),
    },
  };
}
