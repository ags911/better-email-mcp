/**
 * Resend Webhook Receiver
 *
 * Closes the Sent-folder gap for scheduled sends. Resend's webhook payload
 * is metadata-only (email_id, to, from, subject, timestamps) — it does NOT
 * include the message body or attachments, so there is nothing to
 * reconstruct a Sent-folder copy FROM at webhook time.
 *
 * Instead: `resend-client.ts` already builds the full raw MIME message at
 * SEND time (see `buildRawForSentFolder`), for every send, scheduled or not.
 * For an immediate send, `send.ts` appends those bytes to Sent right away.
 * For a scheduled send, the message hasn't actually gone out yet, so
 * appending immediately would be wrong (and premature if the send is later
 * cancelled) — instead `send.ts` hands the raw bytes to
 * `registerPendingSentAppend`, keyed by the Resend message_id, and this
 * module finishes the job when Resend's `email.sent` webhook confirms the
 * message actually went out.
 *
 * Pending entries live in an in-memory Map only — there is no durable store
 * wired up for this deployment (see CLAUDE.md). If the process restarts
 * between scheduling and the webhook firing, the pending entry is lost and
 * that one message's Sent-folder copy is silently skipped; the actual send
 * via Resend is unaffected. `takePendingSentAppend` deletes on read, so a
 * duplicate webhook delivery (Svix redelivers on non-2xx) naturally no-ops
 * on the second attempt rather than double-appending.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRoute } from '@n24q02m/mcp-core'
import type { AccountConfig } from './config.js'
import { appendToFolder, resolveSentFolder } from './imap-client.js'

const LOG_PREFIX = '[better-email-mcp]'
const WEBHOOK_PATH = '/webhooks/resend'

// Svix (Resend's webhook signer) recommends rejecting messages whose
// timestamp is outside a several-minute window, to bound the replay window
// of a captured request.
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300

export interface PendingSentAppend {
  account: AccountConfig
  raw: Buffer
}

const pendingSentAppends = new Map<string, PendingSentAppend>()

/** Called by send.ts right after scheduling a message via Resend. */
export function registerPendingSentAppend(emailId: string, entry: PendingSentAppend): void {
  pendingSentAppends.set(emailId, entry)
}

/**
 * Remove and return a pending entry, if any. Delete-on-read makes both the
 * webhook handler and a manual cancel_scheduled call safe to call more than
 * once for the same emailId without double-appending or leaking memory for
 * cancelled/bounced sends that will never fire `email.sent`.
 */
export function takePendingSentAppend(emailId: string): PendingSentAppend | undefined {
  const entry = pendingSentAppends.get(emailId)
  pendingSentAppends.delete(emailId)
  return entry
}

export interface VerifyWebhookSignatureParams {
  rawBody: string
  svixId: string
  svixTimestamp: string
  svixSignature: string
  secret: string
}

/**
 * Verify a Resend webhook request, signed via Svix.
 *
 * Signed content is `${svixId}.${svixTimestamp}.${rawBody}`, HMAC-SHA256'd
 * with the secret (a `whsec_`-prefixed base64 key), base64-encoded. The
 * `svix-signature` header can carry multiple space-separated `v1,<sig>`
 * candidates; any one matching is valid.
 */
export function verifyResendWebhookSignature(params: VerifyWebhookSignatureParams): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret } = params

  const timestampSeconds = Number(svixTimestamp)
  if (!Number.isFinite(timestampSeconds)) return false
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds)
  if (ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return false

  let secretBytes: Buffer
  let expected: Buffer
  try {
    secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
    expected = createHmac('sha256', secretBytes).update(signedContent).digest()
  } catch {
    return false
  }

  const candidates = svixSignature
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((sig): sig is string => Boolean(sig))

  return candidates.some((candidate) => {
    try {
      const candidateBytes = Buffer.from(candidate, 'base64')
      return candidateBytes.length === expected.length && timingSafeEqual(candidateBytes, expected)
    } catch {
      return false
    }
  })
}

export interface ResendWebhookEvent {
  type: string
  data?: {
    email_id?: string
    to?: string[] | string
    from?: string
    subject?: string
    [key: string]: unknown
  }
}

/**
 * Dispatch a verified Resend webhook event.
 *  - `email.sent`: append the held raw bytes to Sent, if this server was the
 *    one that scheduled it (no pending entry ⇒ an immediate send that
 *    already saved itself, or a send this process never scheduled ⇒ no-op).
 *  - `email.bounced` / `email.complained`: no Sent-folder copy to make; log
 *    it so it's visible instead of silently dropped.
 */
export async function handleResendWebhookEvent(event: ResendWebhookEvent): Promise<void> {
  const emailId = event.data?.email_id
  if (!emailId) return

  switch (event.type) {
    case 'email.sent': {
      const pending = takePendingSentAppend(emailId)
      if (!pending) return
      try {
        const sentFolder = await resolveSentFolder(pending.account)
        await appendToFolder(pending.account, sentFolder, pending.raw, ['\\Seen'])
      } catch (err) {
        console.error(`${LOG_PREFIX} Sent-folder append failed for scheduled email ${emailId}:`, err)
      }
      return
    }

    case 'email.bounced':
    case 'email.complained': {
      takePendingSentAppend(emailId)
      console.error(
        `${LOG_PREFIX} Resend ${event.type}: email_id=${emailId} to=${JSON.stringify(event.data?.to)} subject=${event.data?.subject ?? ''}`
      )
      return
    }

    default:
      return
  }
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * The HTTP route registered on the same port as `/mcp` (see transports/http.ts).
 * Bypasses Bearer-JWT auth entirely — Resend can't present our OAuth token,
 * so the Svix signature IS the authentication here. Fails closed: an unset
 * secret, missing headers, or a bad signature all reject with 4xx and never
 * reach `handleResendWebhookEvent`.
 */
export function createResendWebhookRoute(): HttpRoute {
  return {
    method: 'POST',
    path: WEBHOOK_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const secret = process.env.RESEND_WEBHOOK_SECRET?.trim()
      if (!secret) {
        console.error(`${LOG_PREFIX} Resend webhook received but RESEND_WEBHOOK_SECRET is not set — rejecting`)
        sendJson(res, 401, { error: 'webhook not configured' })
        return
      }

      const rawBody = await readRawBody(req)
      const svixId = firstHeaderValue(req.headers['svix-id'])
      const svixTimestamp = firstHeaderValue(req.headers['svix-timestamp'])
      const svixSignature = firstHeaderValue(req.headers['svix-signature'])

      if (!svixId || !svixTimestamp || !svixSignature) {
        sendJson(res, 400, { error: 'missing svix headers' })
        return
      }

      const valid = verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp, svixSignature, secret })
      if (!valid) {
        console.error(`${LOG_PREFIX} Resend webhook signature verification failed — rejecting`)
        sendJson(res, 401, { error: 'invalid signature' })
        return
      }

      let event: ResendWebhookEvent
      try {
        event = JSON.parse(rawBody)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }

      // Respond before doing the (possibly slow) IMAP round-trip, so a slow
      // mailbox can't make Svix consider this delivery timed out and retry.
      sendJson(res, 200, { received: true })

      try {
        await handleResendWebhookEvent(event)
      } catch (err) {
        console.error(`${LOG_PREFIX} Error handling Resend webhook event:`, err)
      }
    }
  }
}
