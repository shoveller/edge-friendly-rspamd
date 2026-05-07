# Edge Friendly Rspamd

> Rspamd의 다중 신호 점수화 철학에서 출발한 Cloudflare Edge 친화적 결정론적 메일 방화벽입니다.

[English README](./README.md)

Edge Friendly Rspamd는 Rspamd 자체를 Cloudflare Worker에 이식하는 프로젝트가 아닙니다. Rspamd가 오래 검증한 “여러 싼 신호를 점수화해 최종 정책을 결정한다”는 방식을 Cloudflare Email Routing, Hono, TypeScript에 맞게 작게 재구성하는 오픈소스 메일 방화벽 실험입니다.

현재 구현된 것은 `POST /check` 하나입니다. `/check-raw`, `/quarantine`, `/triage`는 로드맵으로 남겨두었습니다.

관련 링크:

- 설계 초안: https://wiki.illuwa.click/page/00%20Inbox/Cloudflare%20Edge%20Friendly%20Rspamd%20%EC%84%A4%EA%B3%84%20%EC%B4%88%EC%95%88.md
- Cloudflare spam filtering 예시: https://developers.cloudflare.com/email-service/examples/email-routing/spam-filtering/
- Hono: https://hono.dev/

빠른 시작:

```bash
npm install
npm run dev
```

검증:

```bash
npm run check
```

---

## 핵심 아이디어

Rspamd 전체를 Edge로 옮기지 않습니다. 대신 Edge에서 유용한 핵심만 다시 만듭니다.

> 싸고 결정적인 신호를 먼저 많이 점수화하고, 비싸거나 애매한 분석은 격리 이후로 미룹니다.

안전한 메일 ingress 흐름은 다음과 같아야 합니다.

```text
Cloudflare Email Routing
→ saasmail/local wrapper email()
→ Edge Friendly Rspamd
   ├─ /check      싼 metadata 결정
   ├─ /check-raw  제한된 raw-mail 검사       (로드맵)
   ├─ /quarantine R2 + D1 + Queue 수집       (로드맵)
   └─ triage      Sandbox/LLM 비동기 분석    (로드맵)
→ upstream saasmail inbox 또는 검증된 agent event
```

첫 릴리스 범위는 의도적으로 좁습니다.

```text
POST /check only
```

---

## 해결하려는 문제

Cloudflare Email Routing은 메일을 Worker로 직접 전달할 수 있습니다. 이 구조는 메일 주소를 inbox로 쓰기에 편하지만, 자동화와 연결되면 공개 ingress 지점이 됩니다.

agent용 메일 주소는 사실상 다음과 같습니다.

```text
agent email address = public webhook/API endpoint
```

메일함이 Hermes, GitHub, OpenCode, 다른 자동화 표면을 깨울 수 있다면 일반 스팸 필터만으로는 부족합니다. 방화벽은 다음 단계를 분리해야 합니다.

```text
raw mail received
→ policy-scored mail
→ validated event
→ approved task
→ agent action
```

Edge Friendly Rspamd는 이 중 policy scoring layer에 집중합니다.

| 요구사항                 | 현재 상태                                                                 |
| ------------------------ | ------------------------------------------------------------------------- |
| 싼 metadata scoring      | `POST /check`                                                             |
| 명시적 action model      | `accept`, `reject`, `drop`, `quarantine`, `inspect_raw`, `relay`, `reply` |
| agent-facing strict mode | `github-event-ingress`, `command-ingress` policy mode                     |
| audit-friendly decision  | score + reason list + decision id                                         |
| raw body inspection      | 로드맵: `/check-raw`                                                      |
| quarantine corpus        | 로드맵: `/quarantine`                                                     |
| async Sandbox/LLM triage | 로드맵: queue consumer / admin triage                                     |

---

## 왜 metadata first인가

메일 수신 경로는 공격자가 호출할 수 있는 public ingress입니다. 그래서 동기 경로는 빠르고, 싸고, 결정적이며, bounded 해야 합니다.

`POST /check`는 raw mail body를 읽지 않고 다음 metadata만 점수화합니다.

- recipient allowlist
- sender/domain allowlist와 blocklist
- SPF/DKIM/DMARC summary
- raw size
- subject keyword, punctuation, caps pattern
- attachment presence
- agent-facing alias strictness

LLM, Cloudflare Sandbox, URL fetch, 첨부파일 분석은 첫 결정 endpoint가 아니라 quarantine 이후로 가야 합니다.

---

## API

### `POST /check`

Metadata-only decision endpoint입니다.

요청 예시:

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

응답 예시:

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

| Action        | 의미                                                           |
| ------------- | -------------------------------------------------------------- |
| `accept`      | `saasmail.email()` 같은 upstream mail handler로 통과           |
| `reject`      | SMTP/Email Worker boundary에서 wrapper가 거절                  |
| `drop`        | 조용히 폐기. backscatter 회피에 유용                           |
| `quarantine`  | raw mail 저장 후 비동기 review enqueue. 로드맵                 |
| `inspect_raw` | wrapper가 향후 `/check-raw`를 제한된 raw input으로 호출해야 함 |
| `relay`       | 명시적 relay/forwarding policy 예약                            |
| `reply`       | 제한된 auto-reply policy 예약. agent alias에서는 기본 비활성화 |

---

## 현재 범위

구현됨:

- `create-hono` 기반 Hono Cloudflare Workers scaffold
- `POST /check`
- 결정론적 policy scorer
- typed decision model
- low-risk, allowlist reject, agent strict quarantine, raw-inspection request, invalid JSON 테스트
- TypeScript/ESLint/Prettier/Vitest quality gate

아직 구현하지 않음:

- Email Worker `email()` wrapper adapter
- Durable Object state coordinator
- D1 decision log
- KV policy store
- R2 quarantine storage
- Queue triage consumer
- Cloudflare Sandbox 또는 LLM analysis

---

## 로드맵

### `/check-raw`

제한된 deterministic raw-mail inspection입니다.

계획된 용도:

- body secret/passphrase policy
- MIME sanity check
- URL fetch 없는 URL pattern count
- attachment metadata check
- deterministic phishing indicator

이 endpoint는 LLM, Cloudflare Sandbox, 외부 URL fetch, unbounded attachment analysis를 실행하면 안 됩니다.

### `/quarantine`

Storage와 async triage enqueue layer입니다.

계획된 리소스:

- raw `.eml` 저장용 R2
- quarantine metadata와 decision log용 D1
- async triage job용 Queue
- 선택적 Durable Object reputation update

### `/triage`

공개 endpoint보다 Queue consumer 중심의 비동기 분석 layer가 적합합니다.

계획된 작업:

- Sandbox/LLM classification
- phishing/social-engineering summary
- GitHub issue/PR/repo link validation
- human review recommendation
- reputation update proposal

추천 admin shape:

```text
POST /admin/quarantine/:id/triage
```

---

## 개발

설치:

```bash
npm install
```

로컬 실행:

```bash
npm run dev
```

Cloudflare binding type 생성:

```bash
npm run cf-typegen
```

전체 검증:

```bash
npm run check
```

개별 검증:

```bash
npm run typecheck
npm run lint
npm run format -- --check
npm run test
```

실제 Cloudflare 계정과 binding을 설정한 뒤 배포:

```bash
npm run deploy
```

---

## 설계 원칙

1. **LLM은 첫 번째 방화벽이 아닙니다.** 먼저 deterministic scoring을 사용합니다.
2. **agent-facing alias는 human inbox보다 엄격합니다.** 알 수 없는 발신자가 executable event가 되면 안 됩니다.
3. **raw mail과 validated event는 별도 객체입니다.** raw body text를 agent에게 직접 넘기지 않습니다.
4. **비싼 분석은 비동기입니다.** Sandbox/LLM work는 quarantine 이후에 있어야 합니다.
5. **엔진은 오픈소스로, private state는 비공개로 둡니다.** Alias list, allowlist, honeypot, quarantine corpus는 private로 유지합니다.

---

## 라이선스

MIT
