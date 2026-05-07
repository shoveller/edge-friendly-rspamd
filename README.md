# Edge Friendly Rspamd

> A Cloudflare-edge deterministic mail firewall inspired by Rspamd's multi-signal scoring philosophy.

Edge Friendly Rspamd is a small Hono + Cloudflare Workers project for protecting Cloudflare Email Routing, saasmail, and agent-facing mailboxes before untrusted email becomes an inbox message or an agent event.

This repository currently implements only `POST /check`: a cheap metadata-only decision endpoint. Raw inspection, quarantine storage, and async triage are intentionally left on the roadmap.

Links:

- Korean README: [README.ko.md](./README.ko.md)
- Design seed: https://wiki.illuwa.click/page/00%20Inbox/Cloudflare%20Edge%20Friendly%20Rspamd%20%EC%84%A4%EA%B3%84%20%EC%B4%88%EC%95%88.md
- Cloudflare spam filtering example: https://developers.cloudflare.com/email-service/examples/email-routing/spam-filtering/
- Hono: https://hono.dev/

Quick start:

```bash
npm install
npm run dev
```

Run the quality gate:

```bash
npm run check
```

---

## Core Idea

Do not port Rspamd to Cloudflare Workers. Instead, rebuild the useful part for the edge:

> Many cheap, deterministic signals are scored first. Expensive or ambiguous analysis happens only after quarantine.

A safe mail-ingress flow should look like this:

```text
Cloudflare Email Routing
→ saasmail/local wrapper email()
→ Edge Friendly Rspamd
   ├─ /check      cheap metadata decision
   ├─ /check-raw  bounded raw-mail inspection       (roadmap)
   ├─ /quarantine R2 + D1 + Queue ingest            (roadmap)
   └─ triage      Sandbox/LLM async analysis        (roadmap)
→ upstream saasmail inbox or validated agent event
```

The first release is intentionally narrow:

```text
POST /check only
```

---

## The Problem Edge Friendly Rspamd Solves

Cloudflare Email Routing can deliver mail directly into a Worker. That makes email addresses useful as inboxes, but also risky as public ingress points for automation.

For agent mailboxes, an email address is effectively:

```text
agent email address = public webhook/API endpoint
```

A normal spam filter is not enough when a mailbox can trigger Hermes, GitHub, OpenCode, or another automation surface. The firewall must separate:

```text
raw mail received
→ policy-scored mail
→ validated event
→ approved task
→ agent action
```

Edge Friendly Rspamd focuses on that policy-scoring layer.

| Requirement              | Current capability                                                        |
| ------------------------ | ------------------------------------------------------------------------- |
| Cheap metadata scoring   | `POST /check`                                                             |
| Explicit action model    | `accept`, `reject`, `drop`, `quarantine`, `inspect_raw`, `relay`, `reply` |
| Agent-facing strict mode | `github-event-ingress` and `command-ingress` policy modes                 |
| Audit-friendly decisions | score + reason list + decision id                                         |
| Raw body inspection      | Roadmap: `/check-raw`                                                     |
| Quarantine corpus        | Roadmap: `/quarantine`                                                    |
| Async Sandbox/LLM triage | Roadmap: queue consumer / admin triage                                    |

---

## Why Metadata First

The synchronous mail path is attacker-controlled. It must be fast, cheap, deterministic, and bounded.

`POST /check` deliberately avoids raw body parsing and expensive analysis. It scores envelope/header-level metadata such as:

- recipient allowlist
- sender/domain allowlist and blocklist
- SPF/DKIM/DMARC summary
- raw size
- subject keywords and punctuation patterns
- attachment presence
- agent-facing alias strictness

LLMs, Cloudflare Sandbox, URL fetching, and attachment analysis belong after quarantine, not in the first decision endpoint.

---

## API

### `POST /check`

Metadata-only decision endpoint.

Example request:

```json
{
  "recipient": "agent@example.com",
  "sender": "alice@example.org",
  "senderDomain": "example.org",
  "rawSize": 12345,
  "subject": "GitHub issue update",
  "messageId": "<abc@example.org>",
  "auth": {
    "spf": "pass",
    "dkim": "pass",
    "dmarc": "pass"
  },
  "hasAttachments": false,
  "policy": {
    "name": "agent-command-default",
    "mode": "command-ingress",
    "allowedRecipients": ["agent@example.com"],
    "trustedDomains": ["example.org"],
    "rawSizeLimit": 262144
  }
}
```

Example response:

```json
{
  "action": "accept",
  "decisionId": "8f6b7d12-8a2f-4c43-a815-e64c85f59fd5",
  "score": -4,
  "verdict": "trusted",
  "reasons": [
    {
      "rule": "sender.allowlist",
      "score": -3,
      "reason": "sender or sender domain is trusted: alice@example.org",
      "tags": ["policy", "sender"]
    },
    {
      "rule": "auth.any-pass",
      "score": -1,
      "reason": "at least one of SPF, DKIM, or DMARC passed",
      "tags": ["auth"]
    }
  ],
  "policy": "agent-command-default"
}
```

### Action model

| Action        | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `accept`      | Pass to upstream mail handler, such as `saasmail.email()`                          |
| `reject`      | Reject at SMTP/Email Worker boundary via the wrapper                               |
| `drop`        | Silently discard; useful for backscatter avoidance                                 |
| `quarantine`  | Store raw mail and enqueue async review; roadmap implementation                    |
| `inspect_raw` | Wrapper should call future `/check-raw` with bounded raw input                     |
| `relay`       | Reserved for explicit relay/forwarding policies                                    |
| `reply`       | Reserved for restricted auto-reply policies; disabled by default for agent aliases |

---

## Usage with Cloudflare Service Bindings

`edge-friendly-rspamd` is intended to run as an internal policy Worker. The Worker that receives email, such as a Cloudflare Email Worker or a thin saasmail wrapper, calls `POST /check` through a Cloudflare Workers Service Binding and branches on the returned action.

```text
Cloudflare Email Routing
→ mail receiver Worker email(message, env, ctx)
→ env.EDGE_RSPAMD.fetch(POST /check)
→ branch on decision.action
   ├─ accept      → upstream email handler or message.forward(...)
   ├─ reject      → message.setReject(...)
   ├─ drop        → return without forwarding/replying
   ├─ quarantine  → store/enqueue once /quarantine exists; conservative fallback today
   └─ inspect_raw → call future /check-raw; conservative fallback today
```

Cloudflare references:

- Service Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- HTTP Service Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/
- Email Workers Runtime API: https://developers.cloudflare.com/email-routing/email-workers/runtime-api/
- Spam filtering example: https://developers.cloudflare.com/email-service/examples/email-routing/spam-filtering/

### 1. Deploy this policy Worker

```bash
npm install
npm run check
npm run deploy
```

The target Worker service name comes from this repository's `wrangler.jsonc`:

```jsonc
{
  "name": "edge-friendly-rspamd",
  "main": "src/index.ts",
}
```

### 2. Bind it from the caller Worker

Add the Service Binding to the **caller** Worker, not to this policy Worker.

```jsonc
{
  "name": "mail-ingress-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-07",
  "services": [
    {
      "binding": "EDGE_RSPAMD",
      "service": "edge-friendly-rspamd",
    },
  ],
}
```

Then the caller can use `env.EDGE_RSPAMD.fetch(...)`. When constructing a `Request` manually for an HTTP Service Binding, Cloudflare's docs require a valid fully-qualified URL; the hostname is only used to form the request object, while the Service Binding routes it to the bound Worker.

### 3. Email Worker wrapper example

```ts
type Env = {
  EDGE_RSPAMD: { fetch(request: Request): Promise<Response> }
  FORWARD_TO: string
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const payload = {
      recipient: message.to,
      sender: message.from,
      senderDomain: domainFromAddress(message.from),
      rawSize: message.rawSize,
      subject: message.headers.get('subject') ?? '',
      messageId: message.headers.get('message-id') ?? '',
      authResults: message.headers.get('authentication-results') ?? '',
      headers: selectedHeaders(message.headers),
      hasAttachments: mayHaveAttachments(message.headers),
      policy: policyForRecipient(message.to),
    }

    const response = await env.EDGE_RSPAMD.fetch(
      new Request('https://edge-friendly-rspamd/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )

    if (!response.ok) {
      message.setReject('mail policy check failed')
      return
    }

    const decision = await response.json<{
      action: string
      decisionId: string
      score: number
      verdict: string
    }>()

    const auditHeaders = new Headers()
    auditHeaders.set('X-Edge-Rspamd-Decision', decision.action)
    auditHeaders.set('X-Edge-Rspamd-Decision-Id', decision.decisionId)
    auditHeaders.set('X-Edge-Rspamd-Score', String(decision.score))
    auditHeaders.set('X-Edge-Rspamd-Verdict', decision.verdict)

    switch (decision.action) {
      case 'accept':
        await message.forward(env.FORWARD_TO, auditHeaders)
        return
      case 'reject':
        message.setReject(`Rejected by edge-friendly-rspamd: ${decision.verdict}`)
        return
      case 'drop':
        return
      case 'quarantine':
      case 'inspect_raw':
        message.setReject(`Quarantined by policy: ${decision.verdict}`)
        return
      default:
        message.setReject(`Unknown mail policy action: ${decision.action}`)
        return
    }
  },
}

function domainFromAddress(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? ''
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const keys = ['from', 'to', 'subject', 'message-id', 'authentication-results', 'content-type']
  const result: Record<string, string> = {}
  for (const key of keys) {
    const value = headers.get(key)
    if (value) result[key.toLowerCase()] = value
  }
  return result
}

function mayHaveAttachments(headers: Headers): boolean {
  const contentType = headers.get('content-type') ?? ''
  const disposition = headers.get('content-disposition') ?? ''
  return /multipart\/mixed/i.test(contentType) || /attachment/i.test(disposition)
}

function policyForRecipient(recipient: string) {
  const normalized = recipient.toLowerCase()

  if (normalized === 'agent@example.com') {
    return {
      name: 'agent-command-default',
      mode: 'command-ingress',
      allowedRecipients: ['agent@example.com'],
      trustedDomains: ['github.com', 'notifications.github.com'],
      rawSizeLimit: 256 * 1024,
      quarantineScore: -1,
      rejectScore: 3,
      requireBodySecret: true,
    }
  }

  return {
    name: 'human-inbox-default',
    mode: 'human-inbox',
    allowedRecipients: [normalized],
    rawSizeLimit: 1024 * 1024,
    quarantineScore: 4,
    rejectScore: 7,
  }
}
```

### Action handling guidance

| Action        | Caller behavior                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| `accept`      | Forward to the upstream inbox or call the upstream saasmail `email()` handler. |
| `reject`      | Call `message.setReject(reason)` to return a permanent SMTP error.             |
| `drop`        | Return without forwarding or replying, avoiding backscatter.                   |
| `quarantine`  | Roadmap: store raw mail in R2, write D1 metadata, enqueue triage.              |
| `inspect_raw` | Roadmap: call `/check-raw`; until implemented, treat conservatively.           |
| `relay`       | Reserved; reject/drop unless a specific relay policy is configured.            |
| `reply`       | Reserved; keep disabled by default for agent-facing aliases.                   |

For agent-facing aliases, fail closed: if the policy Worker is unavailable, returns an invalid response, or requests an unimplemented `inspect_raw`/`quarantine` path, prefer `reject` or `drop` over forwarding to automation.

### saasmail wrapper shape

If the caller already has an upstream `email()` handler, insert the policy check before invoking it:

```ts
export default {
  async fetch(request, env, ctx) {
    return upstream.fetch(request, env, ctx)
  },

  async email(message, env, ctx) {
    const decision = await checkWithEdgeRspamd(message, env)

    if (decision.action === 'accept') {
      return upstream.email(message, env, ctx)
    }

    if (decision.action === 'reject') {
      message.setReject('Rejected by mail policy')
      return
    }

    return
  },
}
```

---

## Current Scope

Implemented:

- Hono Cloudflare Workers scaffold from `create-hono`
- `POST /check`
- deterministic policy scorer
- typed decision model
- tests for low-risk, allowlist reject, agent strict quarantine, raw-inspection request, and invalid JSON
- TypeScript/ESLint/Prettier/Vitest quality gate

Not implemented yet:

- Email Worker `email()` wrapper adapter
- Durable Object state coordinator
- D1 decision log
- KV policy store
- R2 quarantine storage
- Queue triage consumer
- Cloudflare Sandbox or LLM analysis

---

## Roadmap

### `/check-raw`

Bounded deterministic raw-mail inspection.

Planned use cases:

- body secret/passphrase policy
- MIME sanity checks
- URL pattern counting without fetching URLs
- attachment metadata checks
- deterministic phishing indicators

This endpoint must not run LLMs, Cloudflare Sandbox, external URL fetches, or unbounded attachment analysis.

### `/quarantine`

Storage and async triage enqueue layer.

Planned resources:

- R2 for raw `.eml`
- D1 for quarantine metadata and decision logs
- Queue for async triage jobs
- optional Durable Object reputation update

### `/triage`

Async analysis layer, preferably a Queue consumer instead of a public endpoint.

Planned jobs:

- Sandbox/LLM classification
- phishing/social-engineering summary
- GitHub issue/PR/repo link validation
- human review recommendation
- reputation update proposal

Recommended admin shape:

```text
POST /admin/quarantine/:id/triage
```

---

## Development

Install:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Generate Cloudflare binding types:

```bash
npm run cf-typegen
```

Run checks:

```bash
npm run check
```

Individual checks:

```bash
npm run typecheck
npm run lint
npm run format -- --check
npm run test
```

Deploy when a real Cloudflare account and bindings are configured:

```bash
npm run deploy
```

---

## Design Principles

1. **LLM is not the first firewall.** Use deterministic scoring first.
2. **Agent-facing aliases are stricter than human inboxes.** Unknown senders should not become executable events.
3. **Raw mail and validated events are separate objects.** Do not pass raw body text directly to an agent.
4. **Expensive analysis is asynchronous.** Sandbox/LLM work belongs after quarantine.
5. **Open-source the engine, not private state.** Alias lists, allowlists, honeypots, and quarantine corpora stay private.

---

## License

MIT
