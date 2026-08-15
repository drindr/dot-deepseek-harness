/**
 * Asset routes for the caddy-https plugin: serve Caddy's internal root CA
 * plus a short install guide, so a phone can fetch and trust the CA in a
 * couple of taps (Safari → download profile → Settings → Certificate Trust
 * Settings → full trust).
 */
import { readFile } from 'node:fs/promises'
import { rootCertPath } from './caddy.ts'

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
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

function send(res: import('node:http').ServerResponse, status: number, body: Buffer | string, type: string): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache' })
  res.end(buf)
}

const getOnly = (req: import('node:http').IncomingMessage): boolean =>
  req.method === 'GET' || req.method === 'HEAD'

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
      kind: 'prefix',
      path: BASE,
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
