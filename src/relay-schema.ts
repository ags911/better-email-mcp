/**
 * Config schema for the relay credential form.
 *
 * The form is rendered by mcp-core's shared `renderCredentialForm` via the
 * schema-level `cardGroup` capability (added in mcp-core 1.20.0). Each card is
 * one email account; the core renderer handles Add/Remove, per-card field
 * cloning, and the Outlook-style device-code follow-up. On submit the form
 * POSTs a JSON array under the `accounts` key:
 *   { accounts: [ { email, password, imap_host, imap_port }, ... ] }
 * The server (`transports/http.ts` -> `assembleEmailCredentials`) reassembles
 * that array into the `EMAIL_CREDENTIALS` string the rest of the codebase
 * consumes, applying the Outlook domain-detect + device-code trigger.
 */

import type { RelayConfigSchema } from '@n24q02m/mcp-core'

export const RELAY_SCHEMA: RelayConfigSchema = {
  server: 'better-email-mcp',
  displayName: 'Email MCP',
  description:
    'Configure one or more email accounts (Gmail, Yahoo, iCloud, Outlook/Hotmail/Live, or custom IMAP). Outlook/Hotmail/Live accounts use OAuth2 and are handled automatically by the server after you submit — leave their password blank.',
  cardGroup: {
    key: 'accounts',
    itemLabel: 'Account',
    heading: 'Email Accounts',
    addButtonLabel: '+ Add Another Account',
    minItems: 1,
    titleField: 'email',
    fields: [
      {
        key: 'email',
        label: 'Email Address',
        type: 'email',
        required: true,
        placeholder: 'you@example.com'
      },
      {
        // Optional so Outlook/Hotmail/Live accounts (email-only, OAuth device
        // code) still pass form validation. The server drops the password for
        // Outlook domains and validates IMAP login for the rest.
        key: 'password',
        label: 'Password',
        type: 'password',
        required: false,
        placeholder: 'Enter app password',
        helpText:
          'App Password for Gmail/Yahoo/iCloud (not your normal password). Leave blank for Outlook/Hotmail/Live — OAuth runs automatically after submit.'
      },
      {
        key: 'imap_host',
        label: 'IMAP Host',
        type: 'text',
        required: false,
        validation: '^\\S*$',
        placeholder: 'imap.example.com',
        helpText: 'Optional. Leave empty for auto-detection. Accepts localhost or a proxy host.'
      },
      {
        key: 'imap_port',
        label: 'IMAP Port',
        type: 'text',
        required: false,
        validation: '^\\d*$',
        placeholder: '993',
        helpText: 'Optional. Default 993. Set a custom port for a local IMAP proxy.'
      },
      {
        key: 'smtp_host',
        label: 'SMTP Host (optional override)',
        type: 'text',
        required: false,
        validation: '^\\S*$',
        placeholder: 'smtp.example.com',
        helpText:
          'Optional. Leave empty to auto-guess from the IMAP host or provider. Set this when SMTP runs on a different host than IMAP (e.g. some cPanel/custom-domain mail setups).'
      },
      {
        key: 'smtp_port',
        label: 'SMTP Port',
        type: 'text',
        required: false,
        validation: '^\\d*$',
        placeholder: '465',
        helpText: 'Optional. Default depends on security setting (465 for TLS/SSL, 587 for STARTTLS, 25 for none).'
      },
      {
        key: 'smtp_security',
        label: 'SMTP Security',
        type: 'text',
        required: false,
        validation: '^(tls|ssl|starttls|none)?$',
        placeholder: 'tls',
        helpText:
          'Optional. One of: tls / ssl (implicit TLS, port 465), starttls (port 587), none (plain, port 25). Leave blank to default to starttls.'
      }
    ]
  }
}