import { Hono } from 'hono'
import { renderer } from './renderer'
import { BadCheckRequest, evaluateCheck } from './policy'
import type { MailDecision } from './types'

export const app = new Hono()

app.use(renderer)

app.get('/', (c) => {
  const sampleDecision: MailDecision = {
    action: 'quarantine',
    decisionId: 'sample-decision-id',
    score: 5,
    verdict: 'suspicious',
    policy: 'agent-command-default',
    reasons: [
      {
        rule: 'sender.first-seen-agent',
        score: 2,
        reason: 'agent-facing alias requires stronger sender trust',
        tags: ['agent', 'sender'],
      },
      {
        rule: 'attachment.agent',
        score: 3,
        reason: 'attachments to agent-facing aliases require quarantine or rejection',
        tags: ['agent', 'attachment'],
      },
    ],
  }

  return c.render(
    <main class="min-h-screen bg-transparent text-slate-100">
      <div class="mx-auto flex min-h-screen max-w-6xl flex-col gap-12 px-6 py-10 lg:px-10">
        <header class="space-y-6 rounded-3xl border border-sky-400/20 bg-slate-950/65 p-8 shadow-2xl shadow-sky-950/20 backdrop-blur">
          <div class="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-emerald-200">
            Cloudflare Workers · Hono · Vite
          </div>
          <div class="space-y-4">
            <h1 class="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Edge Friendly Rspamd
            </h1>
            <p class="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              A deterministic mail firewall for Cloudflare Email Routing and agent-facing inboxes.
              It scores cheap metadata first, rejects unsafe automation ingress early, and saves
              expensive inspection for quarantine-time workflows.
            </p>
          </div>
          <div class="flex flex-wrap gap-3 text-sm text-slate-200">
            <span class="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1">
              POST /check implemented
            </span>
            <span class="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1">
              /check-raw · /quarantine · /triage roadmap
            </span>
            <a
              class="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 font-medium text-sky-200 transition hover:border-sky-300 hover:bg-sky-400/20"
              href="https://developers.cloudflare.com/email-service/examples/email-routing/spam-filtering/"
              rel="noreferrer"
              target="_blank"
            >
              Cloudflare example
            </a>
          </div>
        </header>

        <section class="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <article class="rounded-3xl border border-slate-800 bg-slate-950/70 p-7 shadow-xl shadow-slate-950/30">
            <h2 class="text-xl font-semibold text-white">Ingress flow</h2>
            <ol class="mt-5 space-y-4 text-sm leading-7 text-slate-300">
              <li class="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                <strong class="text-slate-100">1. Metadata-first scoring.</strong> The caller sends
                envelope and header metadata to <code>POST /check</code> through a Service Binding.
              </li>
              <li class="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                <strong class="text-slate-100">2. Deterministic decision.</strong> The Worker
                returns <code> accept </code>, <code> reject </code>, <code> drop </code>,
                <code> quarantine </code>, or <code> inspect_raw </code> with score reasons.
              </li>
              <li class="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                <strong class="text-slate-100">3. Expensive analysis later.</strong> Raw inspection,
                storage, queue triage, and LLM/Sandbox analysis stay off the first synchronous mail
                path.
              </li>
            </ol>
          </article>

          <aside class="rounded-3xl border border-slate-800 bg-slate-950/70 p-7 shadow-xl shadow-slate-950/30">
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-xl font-semibold text-white">Sample decision</h2>
              <span class="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-amber-200">
                suspicious
              </span>
            </div>
            <dl class="mt-5 grid grid-cols-2 gap-3 text-sm text-slate-300">
              <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                <dt class="text-xs uppercase tracking-wide text-slate-500">Action</dt>
                <dd class="mt-1 font-medium text-slate-100">{sampleDecision.action}</dd>
              </div>
              <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                <dt class="text-xs uppercase tracking-wide text-slate-500">Score</dt>
                <dd class="mt-1 font-medium text-slate-100">{sampleDecision.score}</dd>
              </div>
              <div class="col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
                <dt class="text-xs uppercase tracking-wide text-slate-500">Policy</dt>
                <dd class="mt-1 font-medium text-slate-100">{sampleDecision.policy}</dd>
              </div>
            </dl>
            <ul class="mt-5 space-y-3 text-sm leading-6 text-slate-300">
              {sampleDecision.reasons.map((reason) => (
                <li class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                  <div class="flex items-center justify-between gap-3">
                    <code class="text-sky-200">{reason.rule}</code>
                    <span class="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                      {reason.score > 0 ? `+${reason.score}` : reason.score}
                    </span>
                  </div>
                  <p class="mt-2 text-slate-300">{reason.reason}</p>
                </li>
              ))}
            </ul>
          </aside>
        </section>

        <section class="grid gap-6 md:grid-cols-3">
          <article class="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 class="text-lg font-semibold text-white">Cheap path only</h2>
            <p class="mt-3 text-sm leading-7 text-slate-300">
              The initial decision endpoint intentionally avoids raw body parsing, external fetches,
              Sandbox runs, and LLM calls.
            </p>
          </article>
          <article class="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 class="text-lg font-semibold text-white">Agent-safe defaults</h2>
            <p class="mt-3 text-sm leading-7 text-slate-300">
              Agent-facing aliases can quarantine first-seen senders, react to attachments, and fail
              closed when a raw inspection path is still unimplemented.
            </p>
          </article>
          <article class="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 class="text-lg font-semibold text-white">Public API remains stable</h2>
            <p class="mt-3 text-sm leading-7 text-slate-300">
              The Vite layer adds a documented home page and CSS pipeline without changing the
              existing <code>POST /check</code> contract.
            </p>
          </article>
        </section>
      </div>
    </main>,
  )
})

app.post('/check', async (c) => {
  let payload: unknown

  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'request body must be JSON' }, 400)
  }

  try {
    return c.json(evaluateCheck(payload))
  } catch (error) {
    if (error instanceof BadCheckRequest) {
      return c.json({ error: 'bad_request', message: error.message }, 400)
    }

    throw error
  }
})

export default app
