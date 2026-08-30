# Features Wishlist — this fork

Ideas surfaced during real work on `ags911/better-email-mcp`, deliberately not built yet because the cost/complexity didn't clear the bar at the time. Revisit if the underlying pain actually recurs — don't build ahead of it.

## Durable persistence for scheduled-send Sent-folder tracking

**Status:** deferred 2026-08-30

**Context:** The Resend webhook (`resend-webhook.ts`) holds the raw MIME bytes for a scheduled send in an in-memory `Map`, keyed by Resend's `message_id`, until `email.sent` confirms it fired — then appends to the Sent folder. If the Railway container restarts between scheduling and the webhook firing, that entry is lost and the Sent-folder copy for that one message is silently skipped. The actual send via Resend is unaffected; only the local audit record is.

**Why deferred:** the exposure window is narrow (hours, for same-day/next-day scheduling — not the full 30-day window Resend allows), the failure mode is non-destructive (recoverable via `get_email_status` using the returned `message_id`), and closing it properly means taking on either a new external dependency (KV store, small DB) or a Railway volume — real ongoing infrastructure for a low-probability, low-severity, already-mitigated gap on a 4-mailbox deployment.

**If it's ever worth building:** the lowest-friction fix needs no new infrastructure — APPEND the raw bytes to a dedicated IMAP "Outbox" folder at *schedule* time (durable, since it's just the mailbox itself) instead of caching in memory, then move it to Sent when the webhook fires (or delete it on cancel/bounce). Trade-off: a scheduled-but-not-yet-sent message would be visible in that Outbox folder before it's actually delivered, which needs to be communicated clearly if a human ever browses that folder directly.

## `list_bounces` messages action

**Status:** deferred 2026-08-30

**Context:** From the Resend Webhook Callback handoff. `email.bounced`/`email.complained` webhook events are currently only logged to server logs (`console.error`, visible via Railway's log viewer) — there's no way to query them through the `messages` tool itself.

**Why deferred:** the handoff's acceptance criteria explicitly treated logging as sufficient ("at minimum log it somewhere visible... exact handling TBD"). Building a new tool action and a structured store for bounce/complaint events before knowing whether log-visibility alone is actually a problem in practice felt like scope creep on the webhook feature.

**If it's ever worth building:** would need the same persistence decision as above (in-memory vs. durable) since bounce/complaint history needs to survive a restart to be useful for a `list_bounces` query — worth solving both persistence questions together rather than separately if this gets picked up.
