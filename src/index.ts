import { Hono } from 'hono'
import { BadCheckRequest, evaluateCheck } from '@/policy'

export const app = new Hono()

app.get('/', (c) =>
  c.json({
    name: 'edge-friendly-rspamd',
    description:
      'Cloudflare-edge deterministic mail firewall inspired by Rspamd scoring principles.',
    endpoints: {
      check: 'POST /check',
    },
    roadmap: ['/check-raw', '/quarantine', '/triage'],
  }),
)

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
