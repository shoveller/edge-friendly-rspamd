import type { AuthSummary, CheckRequest, MailDecision, MailVerdict, RuleResult } from './types'

const DEFAULT_RAW_SIZE_LIMIT = 256 * 1024
const DEFAULT_QUARANTINE_SCORE = 4
const DEFAULT_REJECT_SCORE = 7
const SPAM_KEYWORDS = ['urgent', 'winner', 'lottery', 'free money', 'act now', 'verify account']

export class BadCheckRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadCheckRequest'
  }
}

export function evaluateCheck(input: unknown): MailDecision {
  const request = normalizeCheckRequest(input)
  const policy = request.policy ?? {}
  const reasons: RuleResult[] = []
  let score = 0

  const recipient = request.recipient.toLowerCase()
  const sender = request.sender.toLowerCase()
  const senderDomain = (request.senderDomain ?? domainFromAddress(sender)).toLowerCase()
  const mode = policy.mode ?? 'human-inbox'
  const policyName = policy.name ?? mode

  if (
    policy.allowedRecipients?.length &&
    !includesNormalized(policy.allowedRecipients, recipient)
  ) {
    reasons.push({
      rule: 'recipient.allowlist',
      score: 99,
      reason: `recipient ${recipient} is not in the allowed recipient list`,
      tags: ['policy', 'recipient'],
    })
    return decision('reject', 99, reasons, policyName)
  }

  if (
    includesNormalized(policy.blockedSenders, sender) ||
    includesNormalized(policy.blockedDomains, senderDomain)
  ) {
    score += 8
    reasons.push({
      rule: 'sender.blocklist',
      score: 8,
      reason: `sender or sender domain is blocked: ${sender}`,
      tags: ['policy', 'sender'],
    })
  }

  const trustedSender =
    includesNormalized(policy.trustedSenders, sender) ||
    includesNormalized(policy.trustedDomains, senderDomain)
  if (trustedSender) {
    score -= 3
    reasons.push({
      rule: 'sender.allowlist',
      score: -3,
      reason: `sender or sender domain is trusted: ${sender}`,
      tags: ['policy', 'sender'],
    })
  }

  const rawSizeLimit = policy.rawSizeLimit ?? DEFAULT_RAW_SIZE_LIMIT
  if ((request.rawSize ?? 0) > rawSizeLimit) {
    score += 3
    reasons.push({
      rule: 'size.raw-large',
      score: 3,
      reason: `rawSize ${request.rawSize} exceeds policy limit ${rawSizeLimit}`,
      tags: ['size'],
    })
  }

  const auth = summarizeAuth(request)
  if (auth.dmarc === 'fail') {
    score += 5
    reasons.push({ rule: 'auth.dmarc-fail', score: 5, reason: 'DMARC failed', tags: ['auth'] })
  } else if (auth.spf === 'pass' || auth.dkim === 'pass' || auth.dmarc === 'pass') {
    score -= 1
    reasons.push({
      rule: 'auth.any-pass',
      score: -1,
      reason: 'at least one of SPF, DKIM, or DMARC passed',
      tags: ['auth'],
    })
  }

  const subject = request.subject ?? ''
  for (const keyword of SPAM_KEYWORDS) {
    if (subject.toLowerCase().includes(keyword)) {
      score += 1
      reasons.push({
        rule: 'subject.keyword',
        score: 1,
        reason: `subject contains spam keyword: ${keyword}`,
        tags: ['subject'],
      })
    }
  }

  if (/[!]{3,}|[$]{3,}/.test(subject)) {
    score += 1
    reasons.push({
      rule: 'subject.pattern',
      score: 1,
      reason: 'subject contains repeated spam punctuation',
      tags: ['subject'],
    })
  }

  if (isMostlyUppercase(subject)) {
    score += 1
    reasons.push({
      rule: 'subject.all-caps',
      score: 1,
      reason: 'subject is mostly uppercase',
      tags: ['subject'],
    })
  }

  if (mode !== 'human-inbox') {
    if (!trustedSender) {
      score += 2
      reasons.push({
        rule: 'sender.first-seen-agent',
        score: 2,
        reason: 'agent-facing alias requires stronger sender trust',
        tags: ['agent', 'sender'],
      })
    }

    if (request.hasAttachments) {
      score += 3
      reasons.push({
        rule: 'attachment.agent',
        score: 3,
        reason: 'attachments to agent-facing aliases require quarantine or rejection',
        tags: ['agent', 'attachment'],
      })
    }
  } else if (request.hasAttachments) {
    score += 1
    reasons.push({
      rule: 'attachment.present',
      score: 1,
      reason: 'message contains attachments',
      tags: ['attachment'],
    })
  }

  if (policy.requireBodySecret && score < (policy.rejectScore ?? DEFAULT_REJECT_SCORE)) {
    reasons.push({
      rule: 'policy.body-secret-required',
      score: 0,
      reason: 'recipient policy requires bounded raw body inspection',
      tags: ['policy', 'raw'],
    })
    return decision('inspect_raw', score, reasons, policyName)
  }

  const rejectScore = policy.rejectScore ?? (mode === 'human-inbox' ? DEFAULT_REJECT_SCORE : 3)
  const quarantineScore =
    policy.quarantineScore ?? (mode === 'human-inbox' ? DEFAULT_QUARANTINE_SCORE : -1)

  if (score >= rejectScore) return decision('reject', score, reasons, policyName)
  if (score >= quarantineScore) return decision('quarantine', score, reasons, policyName)
  return decision('accept', score, reasons, policyName)
}

function normalizeCheckRequest(input: unknown): CheckRequest {
  if (!input || typeof input !== 'object') throw new BadCheckRequest('expected a JSON object')
  const candidate = input as Partial<CheckRequest>

  if (typeof candidate.recipient !== 'string' || !candidate.recipient.includes('@')) {
    throw new BadCheckRequest('recipient must be an email address string')
  }

  if (typeof candidate.sender !== 'string' || !candidate.sender.includes('@')) {
    throw new BadCheckRequest('sender must be an email address string')
  }

  if (
    candidate.rawSize !== undefined &&
    (!Number.isFinite(candidate.rawSize) || candidate.rawSize < 0)
  ) {
    throw new BadCheckRequest('rawSize must be a non-negative number')
  }

  return {
    ...candidate,
    recipient: candidate.recipient,
    sender: candidate.sender,
    rawSize: candidate.rawSize ?? 0,
  }
}

function summarizeAuth(request: CheckRequest): AuthSummary {
  const explicit = request.auth ?? {}
  const parsed = parseAuthResults(
    request.authResults ?? request.headers?.['authentication-results'] ?? '',
  )
  return {
    spf: normalizeAuthValue(explicit.spf ?? parsed.spf),
    dkim: normalizeAuthValue(explicit.dkim ?? parsed.dkim),
    dmarc: normalizeAuthValue(explicit.dmarc ?? parsed.dmarc),
  }
}

function parseAuthResults(value: string): AuthSummary {
  const result: AuthSummary = {}
  for (const key of ['spf', 'dkim', 'dmarc'] as const) {
    const match = value.toLowerCase().match(new RegExp(`${key}=([a-z]+)`))
    if (match) result[key] = match[1]
  }
  return result
}

function normalizeAuthValue(value: string | null | undefined): string | null | undefined {
  if (value == null) return value
  return value.toLowerCase()
}

function includesNormalized(values: string[] | undefined, value: string): boolean {
  return values?.some((candidate) => candidate.toLowerCase() === value) ?? false
}

function domainFromAddress(address: string): string {
  return address.split('@')[1] ?? ''
}

function isMostlyUppercase(subject: string): boolean {
  const letters = subject.replace(/[^a-z]/gi, '')
  if (letters.length < 8) return false
  const uppercase = letters.replace(/[^A-Z]/g, '')
  return uppercase.length / letters.length > 0.75
}

function verdictFor(action: MailDecision['action'], score: number): MailVerdict {
  if (action === 'inspect_raw') return 'needs_raw_inspection'
  if (score <= -2) return 'trusted'
  if (score >= 7) return 'dangerous'
  if (score >= 4) return 'spam'
  if (score >= 1) return 'suspicious'
  return 'neutral'
}

function decision(
  action: MailDecision['action'],
  score: number,
  reasons: RuleResult[],
  policy: string,
): MailDecision {
  return {
    action,
    decisionId: crypto.randomUUID(),
    score,
    verdict: verdictFor(action, score),
    reasons,
    policy,
  }
}
