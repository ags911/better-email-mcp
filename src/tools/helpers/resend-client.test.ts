import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (vi.hoisted ensures availability in vi.mock factory) ---
const { mockBuild, MockMailComposer } = vi.hoisted(() => {
  const mockBuild = vi.fn().mockResolvedValue(Buffer.from('raw-email-bytes'))
  const mockCompile = vi.fn().mockReturnValue({ build: mockBuild })
  // biome-ignore lint/complexity/useArrowFunction: must use function keyword for `new` constructor mock
  const MockMailComposer = vi.fn(function () {
    return { compile: mockCompile }
  })
  return { mockBuild, mockCompile, MockMailComposer }
})

vi.mock('nodemailer/lib/mail-composer/index.js', () => ({
  default: MockMailComposer
}))

import {
  cancelScheduledEmailViaResend,
  forwardEmailViaResend,
  getEmailStatusViaResend,
  getResendApiKey,
  replyToEmailViaResend,
  sendNewEmailViaResend,
  shouldUseResend
} from './resend-client.js'

const originalFetch = globalThis.fetch
const originalEnv = process.env.RESEND_API_KEY

function mockFetchOnce(response: { ok: boolean; status?: number; json: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: vi.fn().mockResolvedValue(response.json)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 're_test_key_123'
  mockBuild.mockClear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv === undefined) {
    delete process.env.RESEND_API_KEY
  } else {
    process.env.RESEND_API_KEY = originalEnv
  }
})

describe('getResendApiKey / shouldUseResend', () => {
  it('returns the trimmed key when RESEND_API_KEY is set', () => {
    process.env.RESEND_API_KEY = '  re_abc123  '
    expect(getResendApiKey()).toBe('re_abc123')
    expect(shouldUseResend()).toBe(true)
  })

  it('returns undefined and false when RESEND_API_KEY is unset', () => {
    delete process.env.RESEND_API_KEY
    expect(getResendApiKey()).toBeUndefined()
    expect(shouldUseResend()).toBe(false)
  })

  it('returns undefined and false when RESEND_API_KEY is empty/whitespace', () => {
    process.env.RESEND_API_KEY = '   '
    expect(getResendApiKey()).toBeUndefined()
    expect(shouldUseResend()).toBe(false)
  })
})

describe('sendNewEmailViaResend', () => {
  it('sends a plain new email and returns the Resend message id', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-1' } })

    const result = await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'Hello',
      body: 'Plain text body'
    })

    expect(result.success).toBe(true)
    expect(result.message_id).toBe('resend-id-1')
    expect(result.raw).toBeInstanceOf(Buffer)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer re_test_key_123')

    const payload = JSON.parse(init.body)
    expect(payload.from).toBe('signals@arbiris.uk')
    expect(payload.to).toEqual(['someone@example.com'])
    expect(payload.subject).toBe('Hello')
    expect(payload.text).toBe('Plain text body')
    expect(payload.headers).toBeUndefined()
  })

  it('splits comma-separated to/cc/bcc into arrays', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-2' } })

    await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      bcc: ' d@example.com , e@example.com ',
      subject: 'Multi',
      body: 'body'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.to).toEqual(['a@example.com', 'b@example.com'])
    expect(payload.cc).toEqual(['c@example.com'])
    expect(payload.bcc).toEqual(['d@example.com', 'e@example.com'])
  })

  it('maps attachments to Resend filename/content shape', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-3' } })

    await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'With attachment',
      body: 'see attached',
      attachments: [{ filename: 'test.txt', content_base64: 'aGVsbG8=', content_type: 'text/plain' }]
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.attachments).toEqual([{ filename: 'test.txt', content: 'aGVsbG8=' }])
  })

  it('throws MISSING_CONFIG when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY

    await expect(
      sendNewEmailViaResend('signals@arbiris.uk', { to: 'a@example.com', subject: 'x', body: 'y' })
    ).rejects.toMatchObject({ code: 'MISSING_CONFIG' })

    expect(fetch).not.toBeDefined
  })

  it('throws RESEND_SEND_FAILED with the provider message on a non-2xx response', async () => {
    mockFetchOnce({ ok: false, status: 422, json: { message: 'Invalid `to` field' } })

    await expect(
      sendNewEmailViaResend('signals@arbiris.uk', { to: 'not-an-email', subject: 'x', body: 'y' })
    ).rejects.toMatchObject({ code: 'RESEND_SEND_FAILED', message: expect.stringContaining('Invalid `to` field') })
  })
})

describe('replyToEmailViaResend', () => {
  it('prefixes the subject with Re: and sets threading headers', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-4' } })

    const result = await replyToEmailViaResend('signals@arbiris.uk', {
      to: 'sender@example.com',
      subject: 'Original subject',
      body: 'reply body',
      in_reply_to: '<msg-1@example.com>',
      references: '<msg-0@example.com> <msg-1@example.com>'
    })

    expect(result.success).toBe(true)
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.subject).toBe('Re: Original subject')
    expect(payload.headers['In-Reply-To']).toBe('<msg-1@example.com>')
    expect(payload.headers.References).toBe('<msg-0@example.com> <msg-1@example.com>')
  })

  it('does not double-prefix a subject that already starts with Re:', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-5' } })

    await replyToEmailViaResend('signals@arbiris.uk', {
      to: 'sender@example.com',
      subject: 'Re: Already prefixed',
      body: 'reply body',
      in_reply_to: '<msg-1@example.com>'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.subject).toBe('Re: Already prefixed')
  })

  it('defaults references to in_reply_to when references is not provided', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-6' } })

    await replyToEmailViaResend('signals@arbiris.uk', {
      to: 'sender@example.com',
      subject: 'Subject',
      body: 'reply body',
      in_reply_to: '<msg-1@example.com>'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.headers.References).toBe('<msg-1@example.com>')
  })

  it('throws MISSING_PARAM when in_reply_to is not provided', async () => {
    await expect(
      replyToEmailViaResend('signals@arbiris.uk', { to: 'sender@example.com', subject: 'x', body: 'y' })
    ).rejects.toMatchObject({ code: 'MISSING_PARAM' })
  })
})

describe('forwardEmailViaResend', () => {
  it('prefixes the subject with Fwd: and appends the original body', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-7' } })

    const result = await forwardEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'Original subject',
      body: 'fwd note',
      original_body: 'original message content'
    })

    expect(result.success).toBe(true)
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.subject).toBe('Fwd: Original subject')
    expect(payload.text).toContain('fwd note')
    expect(payload.text).toContain('---------- Forwarded message ----------')
    expect(payload.text).toContain('original message content')
  })

  it('does not double-prefix a subject that already starts with Fwd:', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-8' } })

    await forwardEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'Fwd: Already prefixed',
      body: 'note',
      original_body: 'original'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.subject).toBe('Fwd: Already prefixed')
  })
})

describe('raw MIME bytes for Sent-folder append', () => {
  it('builds raw bytes locally without any network call', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-9' } })

    const result = await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'x',
      body: 'y'
    })

    expect(mockBuild).toHaveBeenCalledTimes(1)
    expect(result.raw).toEqual(Buffer.from('raw-email-bytes'))
  })
})

describe('scheduled sending', () => {
  it('passes scheduled_at through to the Resend payload when provided', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-10' } })

    await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'Scheduled',
      body: 'body',
      scheduled_at: '2026-08-29T08:00:00+01:00'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.scheduled_at).toBe('2026-08-29T08:00:00+01:00')
  })

  it('omits scheduled_at from the payload when not provided', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-11' } })

    await sendNewEmailViaResend('signals@arbiris.uk', {
      to: 'someone@example.com',
      subject: 'Not scheduled',
      body: 'body'
    })

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const payload = JSON.parse(init.body)
    expect(payload.scheduled_at).toBeUndefined()
  })
})

describe('idempotency key', () => {
  it('sends a unique Idempotency-Key header on every send call', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-12' } })
    await sendNewEmailViaResend('signals@arbiris.uk', { to: 'a@example.com', subject: 'x', body: 'y' })
    const firstKey = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Idempotency-Key']
    expect(typeof firstKey).toBe('string')
    expect(firstKey.length).toBeGreaterThan(0)

    mockFetchOnce({ ok: true, json: { id: 'resend-id-13' } })
    await sendNewEmailViaResend('signals@arbiris.uk', { to: 'a@example.com', subject: 'x', body: 'y' })
    const secondKey = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Idempotency-Key']

    expect(secondKey).not.toBe(firstKey)
  })
})

describe('cancelScheduledEmailViaResend', () => {
  it('cancels a scheduled email and returns success', async () => {
    mockFetchOnce({ ok: true, json: { id: 'resend-id-14' } })

    const result = await cancelScheduledEmailViaResend('resend-id-14')

    expect(result).toEqual({ success: true, id: 'resend-id-14' })
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails/resend-id-14/cancel')
    expect(init.method).toBe('POST')
  })

  it('throws RESEND_CANCEL_FAILED when the email has already sent', async () => {
    mockFetchOnce({ ok: false, status: 400, json: { message: 'Email already sent' } })

    await expect(cancelScheduledEmailViaResend('resend-id-15')).rejects.toMatchObject({
      code: 'RESEND_CANCEL_FAILED',
      message: expect.stringContaining('Email already sent')
    })
  })

  it('throws MISSING_CONFIG when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY

    await expect(cancelScheduledEmailViaResend('resend-id-16')).rejects.toMatchObject({ code: 'MISSING_CONFIG' })
  })
})

describe('getEmailStatusViaResend', () => {
  it('returns the mapped status fields for a sent email', async () => {
    mockFetchOnce({
      ok: true,
      json: {
        id: 'resend-id-17',
        last_event: 'delivered',
        created_at: '2026-08-29T08:00:00Z',
        subject: 'Hello',
        to: ['someone@example.com']
      }
    })

    const result = await getEmailStatusViaResend('resend-id-17')

    expect(result).toEqual({
      id: 'resend-id-17',
      status: 'delivered',
      scheduled_at: undefined,
      created_at: '2026-08-29T08:00:00Z',
      subject: 'Hello',
      to: ['someone@example.com']
    })
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails/resend-id-17')
    expect(init.method).toBe('GET')
  })

  it('reports scheduled status and scheduled_at for a not-yet-sent email', async () => {
    mockFetchOnce({
      ok: true,
      json: { id: 'resend-id-18', last_event: 'scheduled', scheduled_at: '2026-08-29T08:00:00Z' }
    })

    const result = await getEmailStatusViaResend('resend-id-18')

    expect(result.status).toBe('scheduled')
    expect(result.scheduled_at).toBe('2026-08-29T08:00:00Z')
  })

  it('throws RESEND_STATUS_FAILED for an unknown email ID', async () => {
    mockFetchOnce({ ok: false, status: 404, json: { message: 'Email not found' } })

    await expect(getEmailStatusViaResend('does-not-exist')).rejects.toMatchObject({
      code: 'RESEND_STATUS_FAILED',
      message: expect.stringContaining('Email not found')
    })
  })

  it('throws MISSING_CONFIG when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY

    await expect(getEmailStatusViaResend('resend-id-19')).rejects.toMatchObject({ code: 'MISSING_CONFIG' })
  })
})
