# Roadmap

This project starts with `POST /check` only. The remaining endpoint families are intentionally staged so the synchronous mail path stays cheap and deterministic.

## 1. `/check-raw`

Bounded raw-mail inspection for deterministic checks that require body or MIME access.

Planned checks:

- shared secret/passphrase policy
- MIME sanity checks
- URL count and suspicious static patterns
- attachment metadata checks
- body keyword/pattern rules

Non-goals:

- no LLM calls
- no Cloudflare Sandbox calls
- no URL fetching
- no unbounded attachment processing

## 2. `/quarantine`

Persist suspicious mail outside the upstream inbox and enqueue async triage.

Planned Cloudflare resources:

- R2: raw `.eml` and optional extracted artifacts
- D1: quarantine metadata, decision log, human review state
- Queue: async triage jobs
- Durable Object: optional sender/domain reputation updates

## 3. `/triage`

Async review and enrichment layer. Prefer a Queue consumer over a public HTTP endpoint.

Planned jobs:

- phishing/social-engineering classification
- LLM summary for human review
- Cloudflare Sandbox analysis for selected quarantined artifacts
- GitHub notification validation
- sender/domain reputation update proposals

Public HTTP triage should be avoided by default. If needed, expose only an Access-protected admin endpoint such as:

```text
POST /admin/quarantine/:id/triage
```
