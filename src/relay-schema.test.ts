import { describe, expect, it } from 'vitest'
import { RELAY_SCHEMA } from './relay-schema.js'

describe('RELAY_SCHEMA', () => {
  it('should have the correct server and displayName', () => {
    expect(RELAY_SCHEMA.server).toBe('better-email-mcp')
    expect(RELAY_SCHEMA.displayName).toBe('Email MCP')
  })

  it('drives the form via a cardGroup keyed on accounts', () => {
    // De-forked: the form is mcp-core's shared card-group renderer, so the
    // schema declares a `cardGroup` (not a flat EMAIL_CREDENTIALS field).
    const group = RELAY_SCHEMA.cardGroup
    expect(group).toBeDefined()
    expect(group?.key).toBe('accounts')
    expect(group?.titleField).toBe('email')
    expect(group?.minItems).toBe(1)
    expect(group?.addButtonLabel).toBe('+ Add Another Account')
    expect(RELAY_SCHEMA.fields).toBeUndefined()
  })

  it('declares the account fields with email required and password optional', () => {
    const fields = RELAY_SCHEMA.cardGroup?.fields ?? []
    expect(fields.map((f) => f.key)).toEqual([
      'email',
      'password',
      'imap_host',
      'imap_port',
      'smtp_host',
      'smtp_port',
      'smtp_security'
    ])

    const email = fields.find((f) => f.key === 'email')
    expect(email?.type).toBe('email')
    expect(email?.required).toBe(true)

    // Optional so Outlook (email-only, OAuth) still passes form validation.
    const password = fields.find((f) => f.key === 'password')
    expect(password?.type).toBe('password')
    expect(password?.required).toBe(false)

    const imapHost = fields.find((f) => f.key === 'imap_host')
    expect(imapHost?.required).toBe(false)
    expect(imapHost?.validation).toBe('^\\S*$')
    const imapPort = fields.find((f) => f.key === 'imap_port')
    expect(imapPort?.required).toBe(false)
    expect(imapPort?.validation).toBe('^\\d*$')
  })

  it('declares optional SMTP override fields for asymmetric IMAP/SMTP topologies', () => {
    const fields = RELAY_SCHEMA.cardGroup?.fields ?? []

    const smtpHost = fields.find((f) => f.key === 'smtp_host')
    expect(smtpHost).toBeDefined()
    expect(smtpHost?.type).toBe('text')
    expect(smtpHost?.required).toBe(false)
    expect(smtpHost?.validation).toBe('^\\S*$')

    const smtpPort = fields.find((f) => f.key === 'smtp_port')
    expect(smtpPort).toBeDefined()
    expect(smtpPort?.type).toBe('text')
    expect(smtpPort?.required).toBe(false)
    expect(smtpPort?.validation).toBe('^\\d*$')

    const smtpSecurity = fields.find((f) => f.key === 'smtp_security')
    expect(smtpSecurity).toBeDefined()
    expect(smtpSecurity?.type).toBe('text')
    expect(smtpSecurity?.required).toBe(false)
    expect(smtpSecurity?.validation).toBe('^(tls|ssl|starttls|none)?$')
  })
})
