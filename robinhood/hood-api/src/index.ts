import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { createApp } from './app.js'
import { env } from './lib/env.js'
import { verifySession } from './lib/firehose-session.js'
import { subscribe, ALL_CHANNELS, type ChannelName } from './services/firehose-hub.js'

const app = createApp()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.get(
  '/v1/ws',
  upgradeWebSocket((c) => {
    const token = c.req.query('token')
    const check = verifySession(token)
    const channelsParam = c.req.query('channels')
    const wanted = new Set<ChannelName>(
      channelsParam
        ? (channelsParam.split(',').filter((ch): ch is ChannelName => (ALL_CHANNELS as string[]).includes(ch)) as ChannelName[])
        : ALL_CHANNELS,
    )

    let unsubscribe: (() => void) | null = null

    return {
      onOpen(_evt, ws) {
        if (!check.ok) {
          ws.send(JSON.stringify({ error: 'session_invalid', hint: check.reason }))
          ws.close(4401, 'invalid session')
          return
        }
        ws.send(
          JSON.stringify({
            type: 'connected',
            channels: [...wanted],
            note: 'One message per event; filter client-side on `channel` or use ?channels=firehose,ticks to subscribe narrower.',
          }),
        )
        unsubscribe = subscribe((event) => {
          if (!wanted.has(event.channel)) return
          try {
            ws.send(JSON.stringify(event))
          } catch {
            // socket closing mid-emit; onClose will clean up
          }
        })
      },
      onClose() {
        unsubscribe?.()
        unsubscribe = null
      },
      onError() {
        unsubscribe?.()
        unsubscribe = null
      },
    }
  }),
)

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[hood-api] listening on :${info.port} — ${env.publicBaseUrl}`)
  console.log(`[hood-api] docs: /v1/openapi.json — health: /v1/health`)
})
injectWebSocket(server)

function shutdown(signal: string) {
  console.log(`[hood-api] ${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
