import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from './config.js'

vi.mock('./imap-client.js', () => ({
  resolveSentFolder: vi.fn(),
  appendToFolder: vi.fn()
}))

import { appendToFolder, resolveSentFolder } from './imap-client.js'
import {
  createResendWebhookRoute,
  handleResendWebhookEvent,
  registerPendingSentAppend,
  takePendingSentAppend,
  verifyResendWebhookSignature
} from './resend-webhook.js'

const mockResolveSentFolder = vi.mocked(resolveSentFolder)
const mockAppendToFolder = vi.mocked(appendToFolder)

const testAccount: AccountConfig = {
  id: 'signals_arbiris_uk',
  email: 'signals@arbiris.uk',
  password: 'pass',
  imap: { host: 'imap.arbiris.uk', port: 993, secure: true },
  smtp: { host: 'smtp.arbiris.uk', port: 465, secure: true }
}

const SECRET = 'whsec_dGVzdHNlY3JldGtleQ==' // whsec_ + base64("testsecretkey")

function sign(body: string, id: string, timestamp: string, secret = SECRET): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signedContent = `${id}.${timestamp}.${body}`
  const sig = createHmac('sha256', secretBytes).update(signedContent).digest('base64')
  return `v1,${sig}`
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveSentFolder.mockResolvedValue('Sent')
  mockAppendToFolder.mockResolvedValue(true)
})

afterEach(() => {
  // Drain any pending entries left over between tests.
  takePendingSentAppend('leftover')
})

describe('verifyResendWebhookSignature', () => {
  it('accepts a correctly signed request', () => {
    const body = '{"type":"email.sent"}'
    const id = 'msg_1'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const svixSignature = sign(body, id, timestamp)

    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature,
        secret: SECRET
      })
    ).toBe(true)
  })

  it('accepts when the matching signature is one of several space-separated candidates', () => {
    const body = '{"type":"email.sent"}'
    const id = 'msg_1'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const real = sign(body, id, timestamp)
    const svixSignature = `v1,bm90dGhlcmlnaHRvbmU= ${real} v2,YW5vdGhlcmZha2U=`

    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature,
        secret: SECRET
      })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const id = 'msg_1'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const svixSignature = sign('{"type":"email.sent"}', id, timestamp)

    expect(
      verifyResendWebhookSignature({
        rawBody: '{"type":"email.bounced"}',
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature,
        secret: SECRET
      })
    ).toBe(false)
  })

  it('rejects when signed with the wrong secret', () => {
    const body = '{"type":"email.sent"}'
    const id = 'msg_1'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const svixSignature = sign(body, id, timestamp, 'whsec_d3Jvbmdrzxk=')

    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature,
        secret: SECRET
      })
    ).toBe(false)
  })

  it('rejects a stale timestamp', () => {
    const body = '{"type":"email.sent"}'
    const id = 'msg_1'
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600)
    const svixSignature = sign(body, id, staleTimestamp)

    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        svixId: id,
        svixTimestamp: staleTimestamp,
        svixSignature,
        secret: SECRET
      })
    ).toBe(false)
  })

  it('rejects a non-numeric timestamp without throwing', () => {
    expect(
      verifyResendWebhookSignature({
        rawBody: '{}',
        svixId: 'id',
        svixTimestamp: 'not-a-number',
        svixSignature: 'v1,abc',
        secret: SECRET
      })
    ).toBe(false)
  })

  it('rejects a malformed secret without throwing', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    expect(
      verifyResendWebhookSignature({
        rawBody: '{}',
        svixId: 'id',
        svixTimestamp: timestamp,
        svixSignature: 'v1,abc',
        secret: 'not-whsec-at-all-###'
      })
    ).toBe(false)
  })
})

describe('registerPendingSentAppend / takePendingSentAppend', () => {
  it('returns the registered entry once, then undefined', () => {
    const entry = { account: testAccount, raw: Buffer.from('raw') }
    registerPendingSentAppend('msg_pending', entry)

    expect(takePendingSentAppend('msg_pending')).toEqual(entry)
    expect(takePendingSentAppend('msg_pending')).toBeUndefined()
  })
})

describe('handleResendWebhookEvent', () => {
  it('appends to Sent for email.sent when a pending entry exists', async () => {
    registerPendingSentAppend('msg_2', { account: testAccount, raw: Buffer.from('raw-bytes') })

    await handleResendWebhookEvent({ type: 'email.sent', data: { email_id: 'msg_2' } })

    expect(mockResolveSentFolder).toHaveBeenCalledWith(testAccount)
    expect(mockAppendToFolder).toHaveBeenCalledWith(testAccount, 'Sent', Buffer.from('raw-bytes'), ['\\Seen'])
    // Consumed — a duplicate delivery of the same event no-ops.
    expect(takePendingSentAppend('msg_2')).toBeUndefined()
  })

  it('no-ops for email.sent when there is no pending entry (immediate send, or unknown to this process)', async () => {
    await handleResendWebhookEvent({ type: 'email.sent', data: { email_id: 'msg_never_scheduled' } })
    expect(mockAppendToFolder).not.toHaveBeenCalled()
  })

  it('swallows an IMAP append failure and logs it rather than throwing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerPendingSentAppend('msg_3', { account: testAccount, raw: Buffer.from('raw') })
    mockAppendToFolder.mockRejectedValue(new Error('IMAP down'))

    await expect(handleResendWebhookEvent({ type: 'email.sent', data: { email_id: 'msg_3' } })).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Sent-folder append failed'), expect.any(Error))
  })

  it('logs email.bounced and drops any pending entry without appending', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerPendingSentAppend('msg_4', { account: testAccount, raw: Buffer.from('raw') })

    await handleResendWebhookEvent({
      type: 'email.bounced',
      data: { email_id: 'msg_4', to: ['dawn@example.com'], subject: 'Hello' }
    })

    expect(mockAppendToFolder).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('email.bounced'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('msg_4'))
    expect(takePendingSentAppend('msg_4')).toBeUndefined()
  })

  it('logs email.complained the same way', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleResendWebhookEvent({ type: 'email.complained', data: { email_id: 'msg_5' } })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('email.complained'))
  })

  it('ignores unknown event types', async () => {
    await handleResendWebhookEvent({ type: 'email.delivered', data: { email_id: 'msg_6' } })
    expect(mockAppendToFolder).not.toHaveBeenCalled()
  })

  it('ignores an event with no email_id', async () => {
    await expect(handleResendWebhookEvent({ type: 'email.sent', data: {} })).resolves.toBeUndefined()
    expect(mockAppendToFolder).not.toHaveBeenCalled()
  })
})

describe('createResendWebhookRoute', () => {
  const originalSecret = process.env.RESEND_WEBHOOK_SECRET

  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
    else process.env.RESEND_WEBHOOK_SECRET = originalSecret
  })

  function fakeRequest(body: string, headers: Record<string, string>) {
    const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> }
    req.headers = headers
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
    return req
  }

  function fakeResponse() {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, unknown>,
      body: '',
      writeHead(status: number, headers: Record<string, unknown>) {
        res.statusCode = status
        res.headers = headers
      },
      end(body: string) {
        res.body = body
      }
    }
    return res
  }

  it('rejects with 401 when RESEND_WEBHOOK_SECRET is not set', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    const route = createResendWebhookRoute()
    const req = fakeRequest('{}', {})
    const res = fakeResponse()

    await route.handler(req as never, res as never)

    expect(res.statusCode).toBe(401)
  })

  it('rejects with 400 when svix headers are missing', async () => {
    const route = createResendWebhookRoute()
    const req = fakeRequest('{}', {})
    const res = fakeResponse()

    await route.handler(req as never, res as never)

    expect(res.statusCode).toBe(400)
  })

  it('rejects with 401 on an invalid signature', async () => {
    const route = createResendWebhookRoute()
    const req = fakeRequest('{"type":"email.sent","data":{"email_id":"x"}}', {
      'svix-id': 'id1',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,not-a-real-signature'
    })
    const res = fakeResponse()

    await route.handler(req as never, res as never)

    expect(res.statusCode).toBe(401)
  })

  it('rejects with 400 on invalid JSON despite a valid signature', async () => {
    const body = 'not json'
    const id = 'id2'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const route = createResendWebhookRoute()
    const req = fakeRequest(body, {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': sign(body, id, timestamp)
    })
    const res = fakeResponse()

    await route.handler(req as never, res as never)

    expect(res.statusCode).toBe(400)
  })

  it('accepts a validly signed email.sent event, responds 200, and processes it', async () => {
    registerPendingSentAppend('msg_route', { account: testAccount, raw: Buffer.from('raw') })

    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'msg_route' } })
    const id = 'id3'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const route = createResendWebhookRoute()
    const req = fakeRequest(body, {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': sign(body, id, timestamp)
    })
    const res = fakeResponse()

    await route.handler(req as never, res as never)
    // The route responds synchronously then processes the event asynchronously.
    await vi.waitFor(() => expect(mockAppendToFolder).toHaveBeenCalledTimes(1))

    expect(res.statusCode).toBe(200)
  })
})
