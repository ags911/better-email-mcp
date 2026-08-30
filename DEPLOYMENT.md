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
| `MCP_RELAY_PASSWORD` | Password-gates the `/authorize` credential form | **Should be set — see Security model below.** Without it, mcp-core logs `WARNING: HTTP mode public deployment without MCP_RELAY_PASSWORD — relay form is open to Internet` at boot, and anyone with the URL can submit mailbox credentials. When set, mcp-core fronts `/authorize` with a real `/login` page: timing-safe password check, a signed 24h session cookie, and brute-force lockout (5 wrong attempts per IP → HTTP 429 for 15 minutes). Does **not** gate `/webhooks/resend` — that route is protected separately by its own Svix signature check, and isn't behind this password. |
| `PUBLIC_URL` | Externally-reachable origin for OAuth redirect / relay links | Set to the Railway production URL. |
| `PORT` / `MCP_PORT` | Bind port | Railway sets one of these automatically; no action usually needed. |

## Persistent storage: the Railway Volume

Per-user credentials (the 4 mailboxes, submitted via the `/authorize` form) are stored encrypted on disk (`~/.better-email-mcp/subs/<sub>/config.json`, mcp-core's `LocalFsBackend`). This only survives a redeploy if a Railway Volume is mounted over that path.

**Mount the Volume at `/home/node/.better-email-mcp` — not at `/home/node` itself.** This was gotten wrong once already: mounting at `/home/node` (the whole home directory) took down the entire server, not just credential durability. Railway Volumes commonly mount with ownership the container's non-root `node` user can't write to, and mounting one over the *entire* home directory breaks everything else that also lives there — including mcp-core's own internal lock-file directory (`~/.config/mcp/locks`), which it creates unconditionally and does not handle a failure of gracefully. That crashed the whole process in a restart loop, not just our credential store's `ready()` check (which *does* fail gracefully — the "Credential store UNREACHABLE" log line, by design, never crashes the server on its own). Scoping the Volume to the narrower `.better-email-mcp` subdirectory leaves the rest of the home directory — including that lock path — on the container's normal, correctly-owned ephemeral filesystem.

If the narrower mount still hits `EACCES`, the Volume's own ownership needs fixing in Railway (commonly root-owned by default; check whether Railway's Volume settings expose an owning UID/GID — the container runs as `node`, typically UID 1000 on `node:alpine`).

**Setup order matters — do all of this together before resubmitting mailboxes, to avoid yet another round-trip:**
1. Set `MCP_RELAY_PASSWORD` and `CREDENTIAL_SECRET` in Railway.
2. Add the Volume, mounted at `/home/node/.better-email-mcp`.
3. Deploy (an image built after the durable-credential-store change — `ags911/better-email-mcp:durable-creds` or later).
4. Confirm the server actually started (check logs for the `EACCES`/crash-loop pattern before assuming it worked).
5. *Then* visit `/authorize` (you'll hit the new `/login` password prompt first) and submit the 4 mailboxes.

## One-time mailbox setup (`/authorize`)

Visit `https://better-email-mcp-production.up.railway.app/authorize`. With `MCP_RELAY_PASSWORD` set, you'll hit a `/login` password prompt first — see **Security model** below for what protects this when it isn't set.

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

Worth understanding plainly, since these mailboxes handle cold outreach to regulated-finance contacts.

- **`/mcp` (tool calls) is protected**: requires a valid OAuth 2.1 Bearer token, issued after completing the relay form.
- **`/authorize` (the credential form) is protected by `MCP_RELAY_PASSWORD` — but only once it's set.** Without it, there's no login, password, or OTP gating who can submit it — the PKCE/`state` mechanics in the OAuth flow protect against token interception, not against an anonymous visitor submitting the form. With it set, mcp-core fronts `/authorize` with a real password-gated `/login` page (timing-safe check, signed 24h session cookie, brute-force lockout at 5 attempts/15 min). **Set this.** It's a genuine, purpose-built fix, not a network-level workaround — this section previously (incorrectly) claimed no application-level fix existed.
- The **"Workspace / username" field is still a bucket selector, not a password**, independent of `MCP_RELAY_PASSWORD` — if someone else knows or guesses your value (and has passed the relay-password gate), they land in the same storage bucket. Submissions appear to merge into existing data rather than replace it outright.
- `MCP_RELAY_PASSWORD` does **not** gate `/webhooks/resend` — that route is intentionally separate, protected by its own Svix signature check instead (Resend can't present a relay password).
- If `MCP_RELAY_PASSWORD` is somehow not viable, the fallback is network-level (Railway IP allowlisting, private networking, or a proxy that authenticates before traffic reaches this app) — but that should be a last resort, not the default posture.

## What NOT to do

- Don't set `EMAIL_CREDENTIALS` server-side expecting it to be used — this deployment relies on the per-user relay form + durable store, not the single shared env var upstream's stdio mode documents.
- Don't follow README.md's Cloudflare deployment section for this fork — it's a different infrastructure target (Workers + KV) that this fork doesn't use.
- Don't enable Resend's open/click tracking on the sending domain without a deliberate decision — see `CLAUDE.md` for why it's currently off.
