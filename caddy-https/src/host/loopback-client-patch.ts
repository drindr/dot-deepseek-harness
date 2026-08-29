/**
 * Loopback-client patch: serve `@deepseek-ai/dsh-client-connection`'s browser
 * bundle with one targeted rewrite so the GUI treats this plugin's HTTPS front
 * host as a loopback client.
 *
 * Why: the web client decides `connection.isLoopback` purely from
 * `location.hostname`. Through this plugin's Caddy front the hostname is the
 * public host (e.g. a tailnet name), so `dsh-client-ui-settings` builds its
 * settings mirror in "memory" persistence and every settings surface
 * (Models, Provider Proxy, presets, …) fails with "settings are unavailable
 * in this browser". The server side already trusts the front: Caddy rewrites
 * the Host header to the loopback upstream, so privileged `settings.*` /
 * `credentials.*` RPCs pass the loopback fence — only the client-side gate
 * stands in the way.
 *
 * How: an exact route for the bundle path shadows the client-modules
 * `/plugins/` prefix route (exact beats prefix in the webServer matcher —
 * the same mechanism tailscale-patch uses for its privileged `/api` routes),
 * reads the PRISTINE bundle from disk, and applies a one-line string rewrite
 * before serving. No harness files are modified, so `dsh` updates keep
 * working: the anchor is re-matched against every new bundle and a warning is
 * logged if upstream changed the line.
 *
 * Caching: bytes are re-read only when the on-disk file's mtime/size changes
 * (upstream update or HMR rebuild). The route is registered once per fiber;
 * the disposer removes it on teardown.
 */
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Minimal structural face of the webServer service (matches src/index.ts). */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Minimal structural face of the clientModules service (bundle path lookup). */
interface ClientModulesLike {
  clientPath(id: string): string | undefined
}

/** The client package whose bundle computes `connection.isLoopback`. */
const BUNDLE_ID = '@deepseek-ai/dsh-client-connection'

/**
 * Anchor line in the served bundle (single occurrence, verified against
 * dsh-client-connection 0.1.1-rc.2). The rewrite appends one disjunct.
 */
const ANCHOR =
  'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'

function patchedAnchor(host: string): string {
  return (
    'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)' +
    ` || pageLocation.hostname === ${JSON.stringify(host)},`
  )
}

interface BundleCache {
  mtimeMs: number
  size: number
  body: Buffer
}

/**
 * Mount the exact route serving the patched connection bundle.
 * @param web - the harness webServer service.
 * @param clientModules - the client-modules registry (resolves bundle paths).
 * @param host - the configured HTTPS front hostname (bare, no port).
 * @returns disposer removing the route.
 */
export function registerLoopbackClientPatch(
  web: WebServerLike,
  clientModules: ClientModulesLike,
  host: string,
): () => void {
  let cache: BundleCache | null = null
  let anchorWarned = false
  let missingWarned = false

  return web.register({
    kind: 'exact',
    path: `/plugins/${BUNDLE_ID}/client.js`,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      const file = clientModules.clientPath(BUNDLE_ID)
      if (file === undefined) {
        if (!missingWarned) {
          missingWarned = true
          console.warn(`[caddy-https] loopback client patch: bundle ${BUNDLE_ID} not in the client module graph — serving disabled`)
        }
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const info = await stat(file)
        if (cache === null || cache.mtimeMs !== info.mtimeMs || cache.size !== info.size) {
          const source = await readFile(file, 'utf8')
          let body = source
          if (source.includes(ANCHOR)) {
            body = source.replace(ANCHOR, patchedAnchor(host))
          } else if (!anchorWarned) {
            anchorWarned = true
            console.warn(
              '[caddy-https] loopback client patch: anchor line not found in the connection bundle ' +
              '(upstream changed?) — serving it unpatched; settings surfaces will stay loopback-only',
            )
          }
          cache = { mtimeMs: info.mtimeMs, size: info.size, body: Buffer.from(body) }
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(cache.body)
      } catch {
        res.writeHead(404)
        res.end()
      }
    },
  })
}
