# Deployment — this fork (ags911/better-email-mcp)

This document describes how **this fork** is actually deployed and configured. The rest of the repo's docs (`README.md`, upstream's half of `CLAUDE.md`) describe the original open-source project's generic options — npm/npx install, Smithery, Cloudflare Workers self-hosting — none of which is how this fork runs. This fork runs on **Railway**, deployed from a **manually-built Docker Hub image**, serving four `@arbiris.uk` mailboxes for inbox work and cold outreach via Claude.

If you're an AI agent working in this repo, read `CLAUDE.md`'s "THIS FORK" section first — it covers the engineering SOP (branching, testing, shipping a change). This document is the operational/human-facing counterpart: what to actually configure, and why.

## Architecture at a glance

- **Host:** Railway, running `better-email-mcp-production.up.railway.app`
- **Image:** a Docker image built locally (`docker buildx build --platform linux/amd64 ... --push`) and pushed to Docker Hub as `ags911/better-email-mcp:<tag>`, then manually selected in Railway's dashboard. Railway does **not** auto-deploy from GitHub — merging to `main` has no effect on production until a new image is built, pushed, and swapped in.
- **Mode:** HTTP (`--http` / `MCP_TRANSPORT=http`), OAuth 2.1 relay form for credential setup, not `EMAIL_CREDENTIALS` set server-side.
- **Send transport:** Resend's HTTPS API (Railway blocks outbound SMTP ports 25/465/587), with direct SMTP as the fallback if `RESEND_API_KEY` is unset.

## Required environment variables (Railway dashboard)

None of these are set by an AI agent working in this repo — they're entered directly in Railway's dashboard by whoever operates the deployment.

| Variable | Purpose | Notes |
|---|---|---|
| `CREDENTIAL_SECRET` | Encrypts the per-user credential blob (mcp-core's `PerPluginStore`, AES-256-GCM via scrypt) | **Hard requirement** as soon as the durable credential store is in use — without it, `/authorize` submissions fail outright. Any high-entropy string, e.g. `openssl rand -base64 32`. Losing/rotating this value makes all previously-saved credentials unreadable — treat it like a password, back it up. |
| `RESEND_API_KEY` | Switches the send transport from SMTP to Resend's HTTPS API | **Full-access** tier, not Sending-only — `get_email_status`/`cancel_scheduled` need Full-access; a send-only key can't call them. Generated in Resend's dashboard, named per-service (e.g. "Arbiris — Better Email MCP") — do not reuse the `Onboarding` key other integrations depend on. |
| `RESEND_WEBHOOK_SECRET` | Verifies Resend's webhook signature (Svix) | Generated when you create the webhook endpoint in Resend's dashboard (see below). Required for `email.sent`/`email.bounced`/`email.complained` events to be processed — without it, the webhook endpoint returns 401 to everything. |
| `PUBLIC_URL` | Externally-reachable origin for OAuth redirect / relay links | Set to the Railway production URL. |
| `PORT` / `MCP_PORT` | Bind port | Railway sets one of these automatically; no action usually needed. |

## Persistent storage: the Railway Volume

Per-user credentials (the 4 mailboxes, submitted via the `/authorize` form) are stored encrypted on disk (`~/.better-email-mcp/subs/<sub>/config.json`, mcp-core's `LocalFsBackend`). **This only survives a redeploy if a Railway Volume is mounted at `/home/node`** — the container's home directory (confirmed from the Dockerfile's `USER node` on the `node:alpine` image). Without a Volume there, every redeploy wipes all 4 mailboxes' saved credentials, forcing a full re-authentication through the web form.

**Setup order matters:**
1. Add the Volume, mounted at `/home/node`, in Railway's dashboard.
2. Set `CREDENTIAL_SECRET`.
3. Deploy an image built after the durable-credential-store change (`ags911/better-email-mcp:durable-creds` or later).
4. *Then* submit the `/authorize` form.

Doing this out of order (e.g. submitting credentials before the Volume exists) just means one more re-submission is needed once the Volume is in place — not catastrophic, just wasted effort.

## One-time mailbox setup (`/authorize`)

Visit `https://better-email-mcp-production.up.railway.app/authorize`. This form has no login of its own (see **Security model** below) — treat the URL as sensitive.

- **"Workspace / username" field is not a secret, but must be filled in consistently.** It's a plain-text bucket selector (`stableSubEnabled`): the same value on every submission returns you to the same saved data; leaving it blank mints a fresh, disconnected identity every time, so even with durable storage in place you'd see an empty form on every future visit. Pick a specific, non-guessable value (don't use something obvious like the company name) and reuse it exactly every time this form is submitted, on every device.
- Fill in all 4 `@arbiris.uk` mailboxes as separate account cards, using each mailbox's **app password**, not its normal login password.
- Once submitted successfully with the durable store + Volume in place, this should be the last time this form needs completing — it survives future redeploys.

## Resend webhook setup

1. In Resend's dashboard, create a webhook endpoint for `https://better-email-mcp-production.up.railway.app/webhooks/resend`.
2. Subscribe to exactly these three events — the server ignores everything else, so there's no benefit to selecting more:
   - `email.sent` (triggers the Sent-folder IMAP append for scheduled sends)
   - `email.bounced` (logged to server logs)
   - `email.complained` (logged to server logs)
3. Copy the signing secret Resend gives you into Railway as `RESEND_WEBHOOK_SECRET`.
4. Verify: `curl -X POST https://better-email-mcp-production.up.railway.app/webhooks/resend` should return `{"error":"missing svix headers"}` (400) once the secret is set — a `{"error":"webhook not configured"}` (401) means the secret hasn't taken effect yet; a generic `{"error":"not_found"}` means the route itself isn't deployed (wrong/old image).

## Shipping a new image

```bash
git checkout main && git pull
docker buildx build --platform linux/amd64 -t ags911/better-email-mcp:<descriptive-tag> --push .
docker manifest inspect ags911/better-email-mcp:<descriptive-tag>   # confirm "architecture": "amd64"
```

Then swap the tag in Railway's dashboard and deploy — that step, and only that step, is manual. Two known build gotchas (stale Docker digest pin, arm64-by-default on Apple Silicon) are covered in `CLAUDE.md`.

## Security model — what actually protects this deployment

Worth understanding plainly, since these mailboxes handle cold outreach to regulated-finance contacts:

- **`/mcp` (tool calls) is protected**: requires a valid OAuth 2.1 Bearer token, issued after completing the relay form.
- **`/authorize` (the credential form) is *not* protected by anything beyond the URL being unlisted.** There's no login, password, or OTP gating who can submit it — the PKCE/`state` mechanics in the OAuth flow protect against token interception, not against an anonymous visitor submitting the form. Anyone who discovers or guesses the Railway URL gets the same form shown above.
- The **"Workspace / username" field is a bucket selector, not a password** — if someone else knows or guesses your value, they land in the same storage bucket. Submissions appear to merge into existing data rather than replace it outright, but this is still real write access from an unauthenticated party.
- **The practical mitigation today is obscurity of the Railway URL** — not a real access control. If this ever needs to be closed properly, the fix is network-level (Railway IP allowlisting, private networking, or a proxy that authenticates before traffic reaches this app), not something achievable by editing this codebase's application logic alone.

## What NOT to do

- Don't set `EMAIL_CREDENTIALS` server-side expecting it to be used — this deployment relies on the per-user relay form + durable store, not the single shared env var upstream's stdio mode documents.
- Don't follow README.md's Cloudflare deployment section for this fork — it's a different infrastructure target (Workers + KV) that this fork doesn't use.
- Don't enable Resend's open/click tracking on the sending domain without a deliberate decision — see `CLAUDE.md` for why it's currently off.
