import { logger } from "./log.js";
import { sendActivity, updateActivity } from "./teams/send.js";
import type { ConversationReference, OutboundActivity, TeamsCredentials } from "./teams/types.js";

const log = logger("streaming-message");

const DEFAULT_DEBOUNCE_MS = 800;
const PLACEHOLDER = "_…thinking_";

export type StreamingTeamsMessageOptions = {
  creds: TeamsCredentials;
  reference: ConversationReference;
  /** Minimum gap between successive `updateActivity` calls. */
  debounceMs?: number;
  /** Initial body posted as the placeholder. */
  placeholder?: string;
  /** Optional builder for the outbound activity envelope (lets callers add mentions etc.). */
  buildActivity?: (text: string) => OutboundActivity;
};

/**
 * Wraps a single Teams activity in a stream-friendly facade. The first call to
 * `appendText` posts a placeholder via `sendActivity` and captures the id;
 * subsequent calls schedule an `updateActivity` with the accumulated text,
 * throttled by `debounceMs`. `finalize` flushes any pending update.
 *
 * Teams rate-limits per-activity edits at roughly 1 update/second; the default
 * 800 ms debounce keeps us under that with a margin.
 */
export class StreamingTeamsMessage {
  private text = "";
  private activityId: string | null = null;
  private posting: Promise<string> | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingFlight: Promise<void> | null = null;
  private dirty = false;
  private finalized = false;
  private readonly debounceMs: number;
  private readonly placeholder: string;

  constructor(private readonly opts: StreamingTeamsMessageOptions) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.placeholder = opts.placeholder ?? PLACEHOLDER;
  }

  private buildActivity(text: string): OutboundActivity {
    return this.opts.buildActivity
      ? this.opts.buildActivity(text)
      : { type: "message", text };
  }

  /** Append delta to the running text and schedule an update. */
  async appendText(delta: string): Promise<void> {
    if (!delta || this.finalized) return;
    this.text += delta;
    if (!this.activityId && !this.posting) {
      this.posting = this.ensurePosted();
    }
    if (this.posting) await this.posting;
    this.scheduleUpdate();
  }

  /** Wait for any in-flight update to flush, then post the final text. */
  async finalize(finalText?: string): Promise<string | null> {
    if (typeof finalText === "string" && finalText !== this.text) {
      this.text = finalText;
      this.dirty = true;
    }
    this.finalized = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.activityId && !this.posting) {
      this.posting = this.ensurePosted();
    }
    if (this.posting) await this.posting;
    if (this.pendingFlight) await this.pendingFlight;
    if (this.activityId) {
      this.dirty = true;
      await this.flushOnce(this.activityId);
    }
    return this.activityId;
  }

  private async ensurePosted(): Promise<string> {
    if (this.activityId) return this.activityId;
    const body = this.text.length > 0 ? this.text : this.placeholder;
    const out = await sendActivity({
      creds: this.opts.creds,
      reference: this.opts.reference,
      activity: this.buildActivity(body),
    });
    this.activityId = out.id;
    return out.id;
  }

  private scheduleUpdate(): void {
    this.dirty = true;
    if (this.pendingTimer || this.pendingFlight) return; // already queued
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (!this.activityId) return;
      this.pendingFlight = this.flushOnce(this.activityId).finally(() => {
        this.pendingFlight = null;
        if (this.dirty && !this.finalized) this.scheduleUpdate();
      });
    }, this.debounceMs);
  }

  private async flushOnce(activityId: string): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await updateActivity({
        creds: this.opts.creds,
        reference: this.opts.reference,
        activityId,
        activity: this.buildActivity(this.text),
      });
    } catch (err) {
      // Mark dirty again so the next tick retries; updates are idempotent.
      this.dirty = true;
      log.warn("updateActivity failed", { err: (err as Error).message });
    }
  }
}
