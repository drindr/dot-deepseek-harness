/**
 * Asset + push routes for the caddy-https plugin:
 *  - the service worker at /sw.js (scope / — controls the whole PWA),
 *  - Caddy's internal root CA plus a short install guide,
 *  - the Web Push surface: VAPID public key, subscribe/unsubscribe, and a
 *    manual test endpoint (so the full notification chain can be verified
 *    on-device before the harness event triggers land).
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rootCertPath } from './caddy.ts'
import { addSubscription, loadVapidKeys, pushToAll, removeSubscription, type StoredSubscription } from './push.ts'
import { SW_SOURCE } from './sw.ts'

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface RouteConfig {
  host: string
  port: number
}

const BASE = '/plugins/caddy-https'

const GUIDE_HTML = (cfg: RouteConfig): string => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>caddy-https — 安装根证书</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; color: #eee; background: #151517; }
  h1 { font-size: 1.2rem; }
  ol { line-height: 1.7; padding-left: 1.2rem; }
  a { color: #6ea8ff; }
  code { background: #26262b; padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<h1>caddy-https：自签 HTTPS 已就绪</h1>
<p>HTTPS 前端：<code>https://${cfg.host}:${cfg.port}</code>（反向代理到 DSH）</p>
<p>要让 iOS/桌面浏览器信任它（PWA 通知的前提），安装并信任下面的根证书：</p>
<ol>
  <li><a href="${BASE}/root.crt" download="dsh-caddy-root.crt">下载根证书</a>（CA 证书）</li>
  <li><strong>iPhone/iPad</strong>：Safari 打开本页 → 下载 → 设置里安装描述文件 → <code>设置 → 通用 → 关于本机 → 证书信任设置</code> → 打开该证书的完全信任</li>
  <li><strong>桌面浏览器</strong>：把证书导入系统信任库（macOS 钥匙串/Windows 证书存储，标记为受信任）</li>
  <li>完成后访问 <code>https://${cfg.host}:${cfg.port}</code> 应无警告；在 Safari 中"添加到主屏幕"即可把 DSH 装为 PWA</li>
</ol>
</body>
</html>`

function send(res: ServerResponse, status: number, body: Buffer | string, type: string): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache' })
  res.end(buf)
}

const getOnly = (req: IncomingMessage): boolean =>
  req.method === 'GET' || req.method === 'HEAD'

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

/** Collect the request body as UTF-8 text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Mount the root-CA download + guide page. Returns the disposer that removes
 * both routes.
 */
export function registerAssetRoutes(web: WebServerLike, cfg: RouteConfig): () => void {
  const disposers = [
    web.register({
      kind: 'exact',
      path: `${BASE}/root.crt`,
      handler: async (req, res) => {
        if (!getOnly(req)) {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          send(res, 200, await readFile(rootCertPath()), 'application/x-x509-ca-cert')
        } catch {
          send(res, 404, 'root certificate not generated yet — caddy has not finished its first `tls internal` run', 'text/plain; charset=utf-8')
        }
      },
    }),
    web.register({
      // Exact only: a prefix route here would shadow the module loader's
      // /plugins/<id>/client.js (longest-prefix wins over /plugins).
      kind: 'exact',
      path: `${BASE}/`,
      handler: (req, res) => {
        if (!getOnly(req)) {
          res.writeHead(405)
          res.end()
          return
        }
        send(res, 200, GUIDE_HTML(cfg), 'text/html; charset=utf-8')
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Mount the service worker and the Web Push API routes. Returns the
 * disposer removing every route.
 */
export function registerPushRoutes(web: WebServerLike): () => void {
  const disposers = [
    // The service worker MUST live at the origin root so its default scope
    // covers the whole PWA (a worker under /plugins/ would only control that
    // subtree). Served from the harness's own webServer — no dist patches.
    web.register({
      kind: 'exact',
      path: '/sw.js',
      handler: (req, res) => {
        if (!getOnly(req)) {
          res.writeHead(405)
          res.end()
          return
        }
        send(res, 200, SW_SOURCE, 'text/javascript; charset=utf-8')
      },
    }),

    web.register({
      kind: 'exact',
      path: `${BASE}/push/vapid-public-key`,
      handler: async (req, res) => {
        if (!getOnly(req)) {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const keys = await loadVapidKeys()
          sendJson(res, 200, { key: keys.publicKey })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'vapid unavailable' })
        }
      },
    }),

    web.register({
      kind: 'exact',
      path: `${BASE}/push/subscribe`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const body = JSON.parse(await readBody(req)) as Partial<StoredSubscription>
          if (typeof body.endpoint !== 'string' || body.keys === undefined
            || typeof body.keys.p256dh !== 'string' || typeof body.keys.auth !== 'string') {
            sendJson(res, 400, { error: 'expected { endpoint, keys: { p256dh, auth } }' })
            return
          }
          await addSubscription({
            endpoint: body.endpoint,
            keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            createdAt: Date.now(),
          })
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad subscribe payload' })
        }
      },
    }),

    web.register({
      kind: 'exact',
      path: `${BASE}/push/unsubscribe`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const body = JSON.parse(await readBody(req)) as { endpoint?: string }
          if (typeof body.endpoint !== 'string') {
            sendJson(res, 400, { error: 'expected { endpoint }' })
            return
          }
          await removeSubscription(body.endpoint)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad unsubscribe payload' })
        }
      },
    }),

    web.register({
      kind: 'exact',
      path: `${BASE}/push/test`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const { sent, dropped } = await pushToAll({
          title: 'DSH 测试通知',
          body: '推送链路正常 ✓（点按回到会话）',
          tag: 'dsh-test',
          url: '/',
        })
        sendJson(res, 200, { sent, dropped })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
