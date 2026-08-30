/**
 * Send Mega Tool
 * Send new emails, reply, and forward via SMTP
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { appendToFolder, readEmail, resolveSentFolder } from '../helpers/imap-client.js'
import {
  cancelScheduledEmailViaResend,
  forwardEmailViaResend,
  getEmailStatusViaResend,
  replyToEmailViaResend,
  sendNewEmailViaResend,
  shouldUseResend
} from '../helpers/resend-client.js'
import { registerPendingSentAppend, takePendingSentAppend } from '../helpers/resend-webhook.js'
import type { EmailAttachment, SendEmailOptions, SendResult } from '../helpers/smtp-client.js'
import { forwardEmail, replyToEmail, sendNewEmail } from '../helpers/smtp-client.js'

/**
 * Scheduling only exists on the Resend transport — plain SMTP has no way to
 * hold a message and send it later. Reject early with a clear error rather
 * than silently sending immediately, since that's the one behavior a caller
 * relying on scheduling must never get without noticing.
 */
function assertSchedulingSupported(options: SendEmailOptions): void {
  if (options.scheduled_at && !shouldUseResend()) {
    throw new EmailMCPError(
      'scheduled_at requires the Resend transport',
      'SCHEDULING_REQUIRES_RESEND',
      'Set the RESEND_API_KEY environment variable to use scheduled sending, or omit scheduled_at to send immediately via SMTP'
    )
  }
}

/**
 * Transport dispatch: send via Resend's HTTPS API when RESEND_API_KEY is set
 * (see resend-client.ts), otherwise fall back to direct SMTP (smtp-client.ts).
 * This is a deployment-wide switch, not per-account — set the env var when
 * outbound SMTP ports are blocked by the host (e.g. free-tier PaaS
 * providers); leave it unset to keep using SMTP as before.
 */
async function dispatchSendNew(account: AccountConfig, options: SendEmailOptions): Promise<SendResult> {
  assertSchedulingSupported(options)
  return shouldUseResend() ? sendNewEmailViaResend(account.email, options) : sendNewEmail(account, options)
}

async function dispatchReply(account: AccountConfig, options: SendEmailOptions): Promise<SendResult> {
  assertSchedulingSupported(options)
  return shouldUseResend() ? replyToEmailViaResend(account.email, options) : replyToEmail(account, options)
}

async function dispatchForward(
  account: AccountConfig,
  options: SendEmailOptions & { original_body: string }
): Promise<SendResult> {
  assertSchedulingSupported(options)
  return shouldUseResend() ? forwardEmailViaResend(account.email, options) : forwardEmail(account, options)
}

/**
 * Providers whose SMTP servers auto-save sent messages to the Sent folder.
 * IMAP APPEND on these would create duplicates.
 * - Gmail: smtp.gmail.com
 * - Yahoo: smtp.mail.yahoo.com
 * - iCloud: smtp.mail.me.com
 *
 * Only applies when actually sending through that provider's own SMTP
 * server. Resend never touches smtp.gmail.com/etc — it sends over its own
 * HTTPS API — so the provider never sees the message and never auto-saves
 * it, regardless of which provider hosts the account.
 */
function autoSavesToSent(account: AccountConfig): boolean {
  if (shouldUseResend()) return false
  const host = account.smtp.host
  return host.includes('gmail') || host.includes('yahoo') || host.includes('mail.me')
}

/**
 * Best-effort save to Sent folder via IMAP APPEND.
 * Skips providers that auto-save (Gmail, Yahoo, iCloud).
 * Failures are silent — sending already succeeded.
 */
async function saveToSent(account: AccountConfig, result: SendResult): Promise<boolean> {
  if (!result.raw || autoSavesToSent(account)) return false
  try {
    const sentFolder = await resolveSentFolder(account)
    return await appendToFolder(account, sentFolder, result.raw, ['\\Seen'])
  } catch {
    return false
  }
}

export interface SendInput {
  action: 'new' | 'reply' | 'forward' | 'cancel_scheduled' | 'get_email_status'

  // Required for new/reply/forward
  account: string
  body: string

  // Required for new/forward; optional for reply (auto-derived from original sender)
  to?: string

  // Required for new; optional for reply/forward (auto-derived from original subject)
  subject?: string

  // Optional
  cc?: string
  bcc?: string

  // Reply/Forward - reference to original email
  uid?: number
  folder?: string

  // Optional file attachments, symmetric with the attachments download shape
  attachments?: EmailAttachment[]

  // `new` only, Resend-only: ISO 8601 timestamp or natural language (e.g. "in 2 hours").
  // Rejected with SCHEDULING_REQUIRES_RESEND when RESEND_API_KEY is unset.
  scheduled_at?: string

  // Required for cancel_scheduled/get_email_status: the message_id returned
  // from a prior new/reply/forward call made through the Resend transport.
  email_id?: string
}

/**
 * Unified send tool - handles all outbound email operations
 */
export async function send(accounts: AccountConfig[], input: SendInput): Promise<any> {
  return withErrorHandling(async () => {
    // cancel_scheduled/get_email_status act on a Resend message_id directly
    // and don't involve a sending account, so they skip the checks below.
    if (input.action === 'cancel_scheduled') {
      return await handleCancelScheduled(input)
    }

    if (input.action === 'get_email_status') {
      return await handleGetStatus(input)
    }

    if (!input.account) {
      throw new EmailMCPError(
        'account is required for send operations',
        'VALIDATION_ERROR',
        'Provide the sender account email address'
      )
    }

    if (!input.body) {
      throw new EmailMCPError('body is required', 'VALIDATION_ERROR', 'Provide the email body text')
    }

    switch (input.action) {
      case 'new':
        return await handleNew(accounts, input)

      case 'reply':
        return await handleReply(accounts, input)

      case 'forward':
        return await handleForward(accounts, input)

      default:
        throw createUnknownActionError(input.action, 'new, reply, forward, cancel_scheduled, get_email_status')
    }
  })()
}

/**
 * Cancel a Resend-scheduled email before it sends.
 */
async function handleCancelScheduled(input: SendInput): Promise<any> {
  if (!input.email_id) {
    throw new EmailMCPError(
      'email_id is required for cancel_scheduled',
      'VALIDATION_ERROR',
      'Provide the message_id returned when the email was scheduled'
    )
  }

  const result = await cancelScheduledEmailViaResend(input.email_id)

  // A cancelled send will never fire `email.sent`, so drop any pending
  // Sent-folder append registered for it — otherwise it sits in memory
  // forever waiting for a webhook event that's never coming.
  takePendingSentAppend(input.email_id)

  return {
    action: 'cancel_scheduled',
    email_id: input.email_id,
    success: result.success
  }
}

/**
 * Look up delivery/schedule status for a message sent via Resend.
 */
async function handleGetStatus(input: SendInput): Promise<any> {
  if (!input.email_id) {
    throw new EmailMCPError(
      'email_id is required for get_email_status',
      'VALIDATION_ERROR',
      'Provide the message_id returned when the email was sent or scheduled'
    )
  }

  const status = await getEmailStatusViaResend(input.email_id)

  return {
    action: 'get_email_status',
    ...status
  }
}

/**
 * Send a new email
 */
async function handleNew(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.to) {
    throw new EmailMCPError('to is required for new email', 'VALIDATION_ERROR', 'Provide the recipient email address')
  }

  if (!input.subject) {
    throw new EmailMCPError('subject is required for new email', 'VALIDATION_ERROR', 'Provide the email subject')
  }

  const account = resolveSingleAccount(accounts, input.account)

  const result = await dispatchSendNew(account, {
    to: input.to,
    subject: input.subject,
    body: input.body,
    cc: input.cc,
    bcc: input.bcc,
    attachments: input.attachments,
    scheduled_at: input.scheduled_at
  })

  let saved_to_sent = false
  let pending_sent_folder_append = false
  if (input.scheduled_at) {
    // The send hasn't happened yet, so there's nothing to APPEND until
    // Resend's webhook confirms `email.sent` (see resend-webhook.ts). Hold
    // the raw bytes already built above so that webhook can finish the job.
    if (result.raw && !autoSavesToSent(account)) {
      registerPendingSentAppend(result.message_id, { account, raw: result.raw })
      pending_sent_folder_append = true
    }
  } else {
    saved_to_sent = await saveToSent(account, result)
  }

  return {
    action: 'new',
    from: account.email,
    to: input.to,
    subject: input.subject,
    success: result.success,
    message_id: result.message_id,
    status: input.scheduled_at ? 'scheduled' : 'sent',
    scheduled_at: input.scheduled_at,
    saved_to_sent,
    ...(input.scheduled_at ? { pending_sent_folder_append } : {})
  }
}

/**
 * Reply to an email (maintains thread headers)
 * `to` is optional — defaults to the original sender's address
 */
async function handleReply(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for reply action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to reply to (from search/read)'
    )
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  // Read original email to get threading headers + auto-derive `to`
  const original = await readEmail(account, input.uid, folder)

  // Auto-derive `to` from original sender if not provided
  const replyTo = input.to || original.from

  if (!replyTo) {
    throw new EmailMCPError(
      'Could not determine reply-to address',
      'VALIDATION_ERROR',
      'Provide the `to` field explicitly, or ensure the original email has a From address'
    )
  }

  const result = await dispatchReply(account, {
    to: replyTo,
    subject: input.subject || original.subject,
    body: input.body,
    cc: input.cc,
    bcc: input.bcc,
    in_reply_to: original.message_id,
    references: original.references || original.message_id,
    attachments: input.attachments
  })

  const saved_to_sent = await saveToSent(account, result)

  return {
    action: 'reply',
    from: account.email,
    to: replyTo,
    subject: input.subject || `Re: ${original.subject}`,
    in_reply_to: original.message_id,
    success: result.success,
    message_id: result.message_id,
    saved_to_sent
  }
}

/**
 * Forward an email
 */
async function handleForward(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for forward action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to forward (from search/read)'
    )
  }

  if (!input.to) {
    throw new EmailMCPError(
      'to is required for forward action',
      'VALIDATION_ERROR',
      'Provide the recipient email address'
    )
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  // Read original email to include in forward
  const original = await readEmail(account, input.uid, folder)

  const result = await dispatchForward(account, {
    to: input.to,
    subject: input.subject || original.subject,
    body: input.body,
    cc: input.cc,
    bcc: input.bcc,
    original_body: original.body_text,
    attachments: input.attachments
  })

  const saved_to_sent = await saveToSent(account, result)

  return {
    action: 'forward',
    from: account.email,
    to: input.to,
    subject: input.subject || `Fwd: ${original.subject}`,
    success: result.success,
    message_id: result.message_id,
    saved_to_sent
  }
}
