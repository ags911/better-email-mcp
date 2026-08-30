# CLAUDE.md - better-email-mcp

MCP Server cho Email (IMAP/SMTP). TypeScript, Node.js >= 24, bun, ESM.
4 composite tools, 22 actions (messages, folders, attachments, config; outbound new/reply/forward under messages) plus config__open_relay + help. Multi-account, App Passwords, auto-discovery.

---

## THIS FORK: deployment reality & SOP (read this first)

This is `ags911/better-email-mcp`, a fork of `n24q02m/better-email-mcp` (upstream — actively maintained, has its own bot-authored `renovate/*`, `bolt-*`, `jules-*` branches; only ever merge `upstream/main`, not those). It's the live MCP server for four `@arbiris.uk` mailboxes, used from Claude for inbox work and cold outreach (the "03 Cold Outreach" workstream). Everything in the rest of this file below the `---` is upstream's own doc and describes upstream's internal tooling (CD Pipeline, E2E harness, AWS SSM secrets) which **this fork does not use** — treat those sections as background reference only, not as this fork's actual process.

### Deployment architecture — the one thing to never assume

The live server runs on **Railway** (`better-email-mcp-production.up.railway.app`), pulling a **manually-built-and-pushed Docker Hub image tag** (`ags911/better-email-mcp:<tag>`). Railway is **not** wired to auto-deploy from GitHub.

**This means "merged to `main` on GitHub" ≠ "live in production."** This has already caused real confusion once: code was merged and pushed, but the connected MCP tool schema in a live chat still showed the old, pre-merge action set, because Railway was still running an older image tag. Do not tell the user a feature is "live" just because it's merged — the only ways to know what's actually deployed are (a) asking the user what tag Railway currently points to, or (b) checking whether the new behavior actually appears via the live `Better_Email_MCP` MCP tools in the current chat.

**To ship a change to production**, in order:
1. Merge the change into `main` (this repo's actual working branch of record).
2. Build and push a Docker image: `docker buildx build --platform linux/amd64 -t ags911/better-email-mcp:<descriptive-tag> --push .` — see the platform gotcha below, this is not optional.
3. Verify the pushed manifest: `docker manifest inspect ags911/better-email-mcp:<tag>` and confirm `"architecture": "amd64"`.
4. Hand the tag to the user. **Swapping the image tag in Railway's dashboard and redeploying is their manual step** — don't attempt it via API/CLI unless explicitly asked.

`RESEND_API_KEY` and `EMAIL_CREDENTIALS` are Railway environment variables. Never set, guess, or hardcode their values in code, commits, or tool calls — the user enters them directly in Railway's dashboard.

### Docker gotchas (both have actually happened)

1. **Platform mismatch.** Building with plain `docker build` on an Apple Silicon Mac produces an **arm64** image; Railway runs **amd64**. Symptom: Railway deploy fails with "The image ... could not be found" even though the push succeeded and looked fine locally. Always use `docker buildx build --platform linux/amd64 ... --push`, and always confirm the platform with `docker manifest inspect` before calling a push "done."
2. **Bun lockfile / Dockerfile digest drift.** The Dockerfile pins `oven/bun:1-alpine@sha256:...`. If that digest resolves to a bun version older than whatever generated the committed `bun.lock`, `docker build` fails with `Unknown lockfile version`. Before hand-picking a new digest, check whether upstream has already solved it (look for a `renovate/oven-bun-*` branch on `upstream`) — it has happened twice that upstream independently fixed the exact same issue, once landing on the byte-identical digest.

### Branch / merge workflow that's worked well

- Two remotes: `origin` (this fork) and `upstream` (`n24q02m/better-email-mcp`). Periodically `git fetch upstream` and merge `upstream/main` into `origin/main` to pick up real fixes.
- Before assuming a merge will conflict, check ancestry first: `git merge-base --is-ancestor <A> <B>` and `git log A..B --oneline`. Don't guess — it's cheap to check, and upstream has independently fixed things we were about to fix ourselves (same bug, sometimes the same exact solution).
- For an isolated/unrelated fix (a stray type error, a dependency bump), branch off `main`, not off whatever feature branch is currently checked out — keeps one concern per branch and keeps history reviewable.
- Once a branch is fully merged into `main`, delete it (local + `origin`) after confirming with `git merge-base --is-ancestor origin/<branch> origin/main`. Don't let merged branches pile up.

### Verification sequence — run all of this before calling anything done

```bash
bun install
bun run build
bunx vitest run                       # expect 0 failed; note (don't chase away) the 1 skipped test
bunx biome check <touched files>      # or `.` for a full-repo pass before merging into main
bunx tsc --noEmit -p tsconfig.json    # broader than build's tsc --build; catches test-file type errors too
```

`tsc --noEmit` and `biome check .` across the whole repo occasionally surface pre-existing, unrelated issues. Before "fixing" one as part of an unrelated task, confirm it predates your change (`git stash` and re-run, or check `main`) — if it's pre-existing, fix it on its own branch off `main`, not bundled into the feature branch.

### What this fork adds over upstream (context for future changes)

- **`RESEND_API_KEY`** is the deployment-wide send-transport switch: unset → direct SMTP (`smtp-client.ts`); set → Resend's HTTPS API (`resend-client.ts`, via `send.ts`'s `dispatchSendNew/Reply/Forward`). Exists because Railway (like most low-tier PaaS) blocks outbound SMTP ports 25/465/587; Resend sends over HTTPS instead.
- **`messages` tool, `new` action**: optional `scheduled_at` (ISO 8601 or natural language) — Resend-only, errors `SCHEDULING_REQUIRES_RESEND` rather than silently sending immediately if SMTP is active. `cancel_scheduled` and `get_email_status` actions manage a Resend-sent message afterward by its `message_id` (also returned as `message_id` from the original send).
- **`relay-schema.ts`**: optional `smtp_host`/`smtp_port`/`smtp_security` override fields on the OAuth credential relay form, for accounts where SMTP runs on a different host/port than IMAP.
- Every Resend send call carries an `Idempotency-Key` header, to guard against duplicate sends on network-level retry.
- **Tracking pixels: deliberately not implemented.** Resend supports open/click tracking as a domain-level toggle (off by default). Decision was to leave it off given this mailbox sends cold outreach to a compliance/regulated-finance audience — don't add this without asking first.
- **IMAP read path** (`imap-client.ts`, search/read/folders/attachments) has been treated as out of scope for every send-focused change so far. Ask before touching it.

---

## Commands

```bash
# Setup
bun install

# Lint & Type check
bun run check                    # biome check + tsc --noEmit
bun run type-check               # tsc --noEmit only

# Fix
bun run check:fix                # biome fix + type check

# Test
bun run test                     # vitest (--passWithNoTests)
bun run test:watch               # vitest watch
bun run test:coverage            # vitest --coverage
bun vitest run src/tools/helpers/errors.test.ts   # single file

# Build & Dev
bun run build                    # tsc --build tsconfig.build.json + esbuild CLI
bun run dev                      # tsx watch dev server

# Docker
bun run docker:build
bun run docker:run

# Mise shortcuts
mise run setup     # full dev setup
mise run lint      # bun run check
mise run test      # bun run test
mise run fix       # bun run check:fix
```

## Cau truc thu muc

```
src/
  init-server.ts                 # Entry point, env validation
  relay-setup.ts                 # formatCredentials() helper (relay form fields -> EMAIL_CREDENTIALS string)
  relay-schema.ts                # Relay form schema (email credential fields)
  credential-state.ts            # Single-user / stdio credential resolution from env
  auth/                          # Per-user credential store + Outlook OAuth (HTTP mode)
    in-memory-cred-store.ts      # Local per-user store fallback; ephemeral, keyed by JWT sub
    cred-store.ts                # Cloudflare KV write-through store, keyed by JWT sub
    outlook-device-code.ts       # Microsoft device-code OAuth flow
    subject-context.ts           # Per-request JWT-sub scope (AsyncLocalStorage)
  transports/
    http.ts                      # Multi-user HTTP transport with OAuth 2.1
  docs/                          # Markdown docs phuc vu qua MCP resources
  tools/
    registry.ts                  # Tool registration + routing
    composite/                   # Public domains: messages, folders, attachments, config; internal outbound helper: send.ts
    helpers/                     # errors, config, html-utils, imap-client, smtp-client
```

## Env vars

- **stdio mode** (default): `EMAIL_CREDENTIALS` (bat buoc). Format: `user@gmail.com:app-password`
  - Multi-account: `user1@gmail.com:pass1,user2@outlook.com:pass2`
  - Custom IMAP host: `user@custom.com:password:imap.custom.com`
  - Custom IMAP host + port: `user@custom.com:password:imap.custom.com:1993`
  - Local IMAP proxy: `user@custom.com:password:localhost:1993` (`localhost` accepted as host; per-account port)
- **http mode** (opt-in via `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http`): `PUBLIC_URL` (for relay/OAuth redirect URLs). With `MCP_STORAGE_BACKEND=cf-kv`, per-user credentials are encrypted in the KV-backed store (`auth/cred-store.ts`, keyed by JWT `sub`) and survive container recreation; local HTTP falls back to the process-local store (`auth/in-memory-cred-store.ts`). `MCP_AUTH_DISABLE=1` skips Bearer JWT verification (for deploys behind an external auth gateway).
- `PORT` (default `0` = OS-assigned random port), `HOST` (optional bind address)
- `OUTLOOK_CLIENT_ID` -- tu chon, cho self-hosted OAuth2 client. CLI `auth --client-id=<id>` override env var (flag thang env, xem `auth-cli.ts:parseArgs`)
- `OUTLOOK_TENANT` -- tu chon, tenant cho CA device-code LAN token refresh (`oauth2.ts:getOutlookTenant`). Default `consumers` (stdio/CLI) va `common` (http delegated, `auth/outlook-device-code.ts`). Work/school (Entra ID) can `common` hoac tenant GUID -- refresh token cua work/school danh vao `/consumers` se loi `AADSTS7000012`
- `OUTLOOK_SCOPES` -- tu chon, danh sach scope cach nhau bang space (`oauth2.ts:getOutlookScopes`). Dung khi grant duoc consent hep hon default (vd IMAP-only, khong SMTP)
- `OUTLOOK_EXTRA_DOMAINS` -- tu chon, domain cach nhau bang dau phay, gop them vao `OUTLOOK_DOMAINS` de mailbox M365 tren custom domain di duong OAuth thay vi doi password
- CF deploy: 3 bien tren PHAI nam trong `worker.ts:CONTAINER_ENV_KEYS`, khong forward = set o Worker nhung container khong nhan

## Code conventions

- Biome: 2 spaces, 120 line width, single quotes, semicolons as needed, trailing commas none
- Import: `import type` rieng, `.js` extension bat buoc, `node:` prefix cho builtins
- tsconfig: `strict: true`, target es2021, module es2022, moduleResolution Bundler
- Error: `EmailMCPError` + `withErrorHandling()` HOF. `enhanceError()` + `suggestFixes()`.
- Error details duoc sanitize de tranh lo secrets/passwords.
- Test files co-located: `errors.test.ts` canh `errors.ts`
- `noExplicitAny`: off (email API responses dung `any`)

## CD Pipeline

> Upstream's own pipeline — not used by this fork. This fork's actual deploy path is manual: see "THIS FORK: deployment reality & SOP" above.

PSR v10 (workflow_dispatch) -> npm + Docker (amd64+arm64) + GHCR + MCP Registry.

## Luu y

- Outlook/Hotmail/Live dung OAuth2 tu dong (Device Code flow). Token luu tai `~/.better-email-mcp/tokens.json`.
- Gmail, Yahoo, iCloud: dung App Passwords, KHONG phai password thuong.
- Account resolution: filter theo email, id, hoac partial match.
- Composite tool signature: `async function toolName(accounts: AccountConfig[], input: TypedInput): Promise<any>`
- 3-tier token optimization: Tier 1 (compact), Tier 2 (help tool), Tier 3 (MCP Resources).
- Pre-commit: biome check --write, tsc --noEmit, bun run test.
- Secrets: skret SSM namespace `/better-email-mcp/prod` (region `ap-southeast-1`)

## Modes

Two transports, selected in `init-server.ts:52-53`. There is no `MCP_MODE` env var; the old `remote-relay` / `local-relay` distinction was removed (see `transports/http.ts:5`).

- **stdio (default)**: MCP SDK `StdioServerTransport` directly. Reads credentials from `EMAIL_CREDENTIALS` OR `EMAIL_USER` + `EMAIL_APP_PASSWORD`. Outlook accounts use an App Password in this mode.
- **http (opt-in, self-hosted)**: enabled via `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http`. Single multi-user relay: `/authorize` form for App-Password providers (paste `email:app-password`) plus bundled Outlook device-code OAuth. Per-user credentials are keyed by JWT `sub`; the Outlook token file is `~/.better-email-mcp/tokens.json`. The project no longer operates a public n24q02m HTTP deployment.

## Known bugs (phat hien 2026-04-18 E2E)

1. **(Obsolete)** Outlook Device Code "2 tab" duplicate auth — chỉ affect `local-relay` mode, đã bị gỡ cùng với `MCP_MODE` (xem mục Modes). HTTP mode hiện dùng mcp-core delegated device_code, không duplicate.

2. **(Obsolete)** Browser UI stuck "Waiting for server..." — chỉ affect `MCP_MODE=local-relay` (ECDH `relay/client.ts:sendMessage('complete')` paste-form flow), đã bị gỡ. Không còn relay-client path nào live trong HTTP mode.

3. **Config storage path**: stdio/single-user config ghi qua mcp-core `config-file.js` -> `config.enc` tại platformdirs `mcp` config dir (`$APPDATA\mcp\Config\config.enc` trên Windows; khac Python servers `$LOCALAPPDATA\mcp\config.enc`). Khi debug/test, clean ca 2 paths + `~/.better-email-mcp/tokens.json` de reset state.

4. **Outlook token identity**: resolved in the current source. `saveOutlookTokens` resolves the key in this order: token `email`, `OUTLOOK_EMAIL`, token `sub`, decoded `id_token` subject, then the deterministic `outlook-device-code` fallback. `oauth2.test.ts` covers each branch. Keep `OUTLOOK_EMAIL` as an explicit workaround only when the provider response has no usable identity claim; do not treat the old "long-term fix" note as open work.

## E2E

> Upstream's own harness — not set up for this fork (no `mcp-core` sibling checkout, no AWS SSM access here). This fork verifies changes with the commands in "THIS FORK" above instead.

Driven by `mcp-core/scripts/e2e/` (matrix-locked, 15 configs). Run a single config from this repo via `make e2e` (proxy) or directly:

```
cd ../mcp-core && uv run --project scripts/e2e python -m e2e.driver <config-id>
```

Configs for this repo: `email-gmail`, `email-outlook`.

``email-outlook`` is t2-interaction (Microsoft device-code, 900s timeout); user clicks ``microsoft.com/devicelogin``.

Tier policy:

- **T0** (precommit + CI on PR / main push) - runs without upstream identity. Skret keys not required.
- **T2 non-interaction** (`make e2e-config CONFIG=<id>` locally) - driver pre-fills relay form from skret AWS SSM `/better-email-mcp/prod` (`ap-southeast-1`). No user gate.
- **T2 interaction** - driver fills relay form, then prints upstream user-gate URL; user signs in / types OTP at provider. Driver enforces per-flow timeouts (device-code 900s, oauth-redirect 300s, browser-form 600s) and emits `[poll] elapsed=Xs remaining=Ys status=<body>` every 30s. On timeout, container logs + last `setup-status` are saved to `<tmp>/e2e-diag/` BEFORE teardown for post-mortem.

Multi-user remote mode (deployment property; not a separate config) keys per-user credentials by JWT `sub`. Cloudflare deployments use the encrypted KV-backed store (`auth/cred-store.ts`) and survive container recreation; local HTTP deployments use the in-memory fallback (`auth/in-memory-cred-store.ts`) and require re-authentication after restart.

References: `mcp-core/scripts/e2e/matrix.yaml`, `~/.claude/skills/mcp-dev/references/e2e-full-matrix.md` (harness-readiness gate), `~/.claude/skills/mcp-dev/references/secrets-skret.md` (per-server credential layout), `~/.claude/skills/mcp-dev/references/multi-user-pattern.md` (per-JWT-sub isolation).
