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
