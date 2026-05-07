import { describe, expect, it } from 'vitest'
import { app } from '../src/index'
import { evaluateCheck } from '../src/policy'

const baseRequest = {
  recipient: 'contact@example.com',
  sender: 'alice@example.org',
  senderDomain: 'example.org',
  subject: 'Hello',
  rawSize: 1024,
  auth: { spf: 'pass' },
}

describe('POST /check', () => {
  it('accepts a low-risk metadata-only message', async () => {
    const response = await app.request('/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseRequest,
        policy: { trustedDomains: ['example.org'] },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ action: 'accept', verdict: 'trusted' })
  })

  it('rejects a disallowed recipient before scoring other rules', () => {
    const decision = evaluateCheck({
      ...baseRequest,
      recipient: 'unknown@example.com',
      policy: { allowedRecipients: ['contact@example.com'] },
    })

    expect(decision).toMatchObject({ action: 'reject', score: 99 })
    expect(decision.reasons[0]?.rule).toBe('recipient.allowlist')
  })

  it('quarantines first-time senders for agent-facing aliases', () => {
    const decision = evaluateCheck({
      ...baseRequest,
      recipient: 'agent@example.com',
      sender: 'stranger@example.net',
      senderDomain: 'example.net',
      policy: { mode: 'command-ingress' },
    })

    expect(decision.action).toBe('quarantine')
    expect(decision.reasons.map((reason) => reason.rule)).toContain('sender.first-seen-agent')
  })

  it('requests bounded raw inspection when a body secret policy applies', () => {
    const decision = evaluateCheck({
      ...baseRequest,
      policy: { requireBodySecret: true },
    })

    expect(decision).toMatchObject({ action: 'inspect_raw', verdict: 'needs_raw_inspection' })
  })

  it('returns 400 for invalid JSON', async () => {
    const response = await app.request('/check', { method: 'POST', body: '{' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_json' })
  })
})
