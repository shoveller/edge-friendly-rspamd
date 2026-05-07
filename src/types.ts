export type FirewallAction =
  | 'accept'
  | 'reject'
  | 'drop'
  | 'quarantine'
  | 'inspect_raw'
  | 'relay'
  | 'reply'

export type MailVerdict =
  | 'trusted'
  | 'neutral'
  | 'suspicious'
  | 'spam'
  | 'dangerous'
  | 'needs_raw_inspection'

export type AliasMode = 'human-inbox' | 'github-event-ingress' | 'command-ingress'

export type AuthSummary = {
  spf?: string | null | undefined
  dkim?: string | null | undefined
  dmarc?: string | null | undefined
}

export type CheckPolicy = {
  name?: string
  mode?: AliasMode
  allowedRecipients?: string[]
  trustedSenders?: string[]
  trustedDomains?: string[]
  blockedSenders?: string[]
  blockedDomains?: string[]
  rawSizeLimit?: number
  quarantineScore?: number
  rejectScore?: number
  requireBodySecret?: boolean
  allowReply?: boolean
}

export type CheckRequest = {
  recipient: string
  sender: string
  senderDomain?: string
  rawSize?: number
  subject?: string
  messageId?: string
  auth?: AuthSummary
  authResults?: string
  headers?: Record<string, string>
  hasAttachments?: boolean
  policy?: CheckPolicy
}

export type RuleResult = {
  rule: string
  score: number
  reason: string
  tags?: string[]
}

export type MailDecision = {
  action: FirewallAction
  decisionId: string
  score: number
  verdict: MailVerdict
  reasons: RuleResult[]
  policy: string
}
