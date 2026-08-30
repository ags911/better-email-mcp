/**
 * Resend Client
 * Send, reply, and forward emails via the Resend HTTPS API instead of SMTP.
 *
 * Why this exists: many low-cost / free hosts (Railway, Render free tiers,
 * others) block outbound traffic on SMTP ports 25/465/587 to prevent spam
 * abuse, while leaving HTTPS (443) open. Resend's API sends over HTTPS, so
 * it works from those hosts where direct SMTP does not.
 *
 * This module intentionally mirrors `smtp-client.ts`'s exported function
 * shapes (`sendNewEmail`, `replyToEmail`, `forwardEmail`, `SendResult`) so
 * the composite `send.ts` tool can select between the two with a single
 * conditional, rather than needing two different call shapes downstream.
 *
 * Scope / what this does NOT do:
 *  - No raw SMTP envelope; Resend's API takes structured fields (to, from,
 *    subject, html, text, headers, attachments) over HTTPS POST.
 *  - Threading headers (In-Reply-To / References) are passed via Resend's
 *    `headers` field, since there's no raw MIME envelope to set them on
 *    directly the way `smtp-client.ts` does via MailComposer.
 *  - `SendResult.raw` is still populated (via the same `buildRawMessage`
 *    used by the SMTP path) purely so the existing IMAP "save to Sent"
 *    step in `send.ts` keeps working unchanged — Resend does not append to
 *    IMAP itself, so the caller still needs those raw bytes for that step.
 */

import { EmailMCPError } from './errors.js'
import type { EmailAttachment, SendEmailOptions, SendResult } from './smtp-client.js'
import { textToHtml } from './smtp-client.js'

const RESEND_API_URL = 'https://api.resend.com/emails'

export interface ResendAttachment {
  filename: string
  content: string // base64
}

interface ResendSendPayload {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
  attachments?: ResendAttachment[]
}

interface ResendSuccessResponse {
  id: string
}

interface ResendErrorResponse {
  statusCode?: number
  name?: string
  message: string
}

/** Split a comma-separated recipient field into a trimmed, non-empty array. */
function splitRecipients(field: string | undefined): string[] | undefined {
  if (!field) return undefined
  const parts = field
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

/** Map our base64 attachment shape to Resend's `{ filename, content }` shape. */
function mapResendAttachments(attachments: EmailAttachment[] | undefined): ResendAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  return attachments.map((a) => ({ filename: a.filename, content: a.content_base64 }))
}

/**
 * POST a message to the Resend API.
 * Throws EmailMCPError with the provider's own message on a non-2xx response,
 * so callers get an actionable error instead of a generic HTTP failure.
 */
async function callResendApi(apiKey: string, payload: ResendSendPayload): Promise<ResendSuccessResponse> {
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const data = (await response.json()) as ResendSuccessResponse | ResendErrorResponse

  if (!response.ok || !('id' in data)) {
    const err = data as ResendErrorResponse
    throw new EmailMCPError(
      `Resend API error: ${err.message || `HTTP ${response.status}`}`,
      'RESEND_SEND_FAILED',
      'Check the Resend API key and that the sending domain is verified in the Resend dashboard'
    )
  }

  return data
}

/**
 * Build a raw RFC2822 message purely for the IMAP "save to Sent" step.
 * This does not touch the network — it's the same local MIME serialization
 * the SMTP path uses, reused here so send.ts's existing saveToSent() keeps
 * working unchanged regardless of which transport actually delivered the mail.
 */
async function buildRawForSentFolder(mailOptions: {
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  html: string
  inReplyTo?: string
  references?: string
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>
}): Promise<Buffer> {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js')
  const composer = new MailComposer(mailOptions)
  return composer.compile().build()
}

function mapMimeAttachments(
  attachments: EmailAttachment[] | undefined
): Array<{ filename: string; content: Buffer; contentType?: string }> | undefined {
  if (!attachments || attachments.length === 0) return undefined
  return attachments.map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content_base64, 'base64'),
    contentType: a.content_type
  }))
}

/**
 * Resolve the Resend API key for the given account.
 * Single global key (RESEND_API_KEY env var) — Resend verifies at the
 * domain level, not per-mailbox, so one key covers every account on a
 * verified domain (e.g. all @arbiris.uk addresses).
 */
export function getResendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined
}

/** Whether Resend should be used as the send transport for this account. */
export function shouldUseResend(): boolean {
  return Boolean(getResendApiKey())
}

async function sendViaResend(
  fromEmail: string,
  options: SendEmailOptions,
  extra?: { subjectPrefix?: 'Re:' | 'Fwd:'; inReplyTo?: string; references?: string; forwardedBody?: string }
): Promise<SendResult> {
  const apiKey = getResendApiKey()
  if (!apiKey) {
    throw new EmailMCPError(
      'RESEND_API_KEY is not set',
      'MISSING_CONFIG',
      'Set the RESEND_API_KEY environment variable to send via Resend'
    )
  }

  let subject = options.subject
  if (extra?.subjectPrefix && !subject.startsWith(extra.subjectPrefix)) {
    subject = `${extra.subjectPrefix} ${subject}`
  }

  const body = extra?.forwardedBody
    ? `${options.body}\n\n---------- Forwarded message ----------\n${extra.forwardedBody}`
    : options.body

  const html = textToHtml(body)
  const headers: Record<string, string> = {}
  if (extra?.inReplyTo) headers['In-Reply-To'] = extra.inReplyTo
  if (extra?.references) headers.References = extra.references

  const payload: ResendSendPayload = {
    from: fromEmail,
    to: splitRecipients(options.to) ?? [],
    cc: splitRecipients(options.cc),
    bcc: splitRecipients(options.bcc),
    subject,
    text: body,
    html,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(mapResendAttachments(options.attachments) ? { attachments: mapResendAttachments(options.attachments) } : {})
  }

  const result = await callResendApi(apiKey, payload)

  // Build raw MIME bytes locally (no network call) purely so the existing
  // IMAP "save to Sent" step in send.ts has something to append.
  const raw = await buildRawForSentFolder({
    from: fromEmail,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject,
    text: body,
    html,
    inReplyTo: extra?.inReplyTo,
    references: extra?.references,
    attachments: mapMimeAttachments(options.attachments)
  })

  return {
    success: true,
    message_id: result.id,
    raw
  }
}

/** Send a new email via Resend. Mirrors smtp-client.ts's sendNewEmail signature. */
export async function sendNewEmailViaResend(fromEmail: string, options: SendEmailOptions): Promise<SendResult> {
  return sendViaResend(fromEmail, options)
}

/** Reply to an email via Resend. Mirrors smtp-client.ts's replyToEmail signature. */
export async function replyToEmailViaResend(fromEmail: string, options: SendEmailOptions): Promise<SendResult> {
  if (!options.in_reply_to) {
    throw new EmailMCPError(
      'in_reply_to is required for reply',
      'MISSING_PARAM',
      'Use email_read to get the message_id of the email you want to reply to'
    )
  }
  return sendViaResend(fromEmail, options, {
    subjectPrefix: 'Re:',
    inReplyTo: options.in_reply_to,
    references: options.references || options.in_reply_to
  })
}

/** Forward an email via Resend. Mirrors smtp-client.ts's forwardEmail signature. */
export async function forwardEmailViaResend(
  fromEmail: string,
  options: SendEmailOptions & { original_body: string }
): Promise<SendResult> {
  return sendViaResend(fromEmail, options, {
    subjectPrefix: 'Fwd:',
    forwardedBody: options.original_body
  })
}
