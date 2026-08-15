/**
 * caddy-https: Caddy reverse proxy + self-signed TLS for the dsh web GUI.
 *
 * Serves the harness over HTTPS on a tailnet hostname using Caddy's built-in
 * `tls internal` CA — the standard self-signed setup for a plain-http
 * deployment (self-hosted Headscale cannot issue official TLS certs). The
 * goal is a trusted HTTPS front so the iOS Safari PWA gains a SECURE
 * CONTEXT, the hard prerequisite for Web Push notifications on iOS 16.4+.
 *
 * Trust model: the user installs Caddy's internal root CA on each device
 * (iPhone: install the profile, then Settings → General → About →
 * Certificate Trust Settings → enable full trust; desktop browsers: import
 * the root into the system trust store). A fully-trusted self-signed CA is
 * a standard secure context — identical to a public cert for
 * serviceWorker / Notification / push purposes.
 *
 * Jobs (all official harness surface, no harness file patches):
 *  1. Ensure a `caddy` binary — the configured `caddyPath`, or downloaded to
 *     ~/.dsh/caddy-https/ on first activation.
 *  2. Write a Caddyfile (`tls internal` + reverse_proxy to the harness
 *     webServer) and run caddy on the configured port (8443 default — no
 *     root needed).
 *  3. Serve the internal root CA at /plugins/caddy-https/root.crt plus a
 *     small install-guide page, so phones can fetch and trust the CA easily.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ensureCaddyBinary, startCaddy, stopCaddy, type CaddyHandle } from './caddy.ts'
import { registerAssetRoutes } from './routes.ts'

/** Minimal structural face of the webServer service (no type dependency). */
interface WebServerLike {
  config: { host: string; port: number }
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

export const inject = ['webServer']

/** Plugin config: the HTTPS front authority and the loopback target. */
export const Config = z.object({
  /** Public hostname the HTTPS front listens on (must resolve to this host). */
  host: z.string().default(''),
  /** HTTPS listen port (non-privileged; 443 would need root or setcap). */
  port: z.number().default(8443),
  /** The harness webServer port this proxy targets on 127.0.0.1. */
  targetPort: z.number().default(3080),
  /** Explicit caddy binary path; empty → auto-download to ~/.dsh/caddy-https/. */
  caddyPath: z.string().default(''),
})

/** Resolved plugin config shape (schema defaults applied). */
interface CaddyConfig {
  host: string
  port: number
  targetPort: number
  caddyPath: string
}

export function apply(ctx: Context, config: CaddyConfig): void {
  const web = (ctx as unknown as { webServer: WebServerLike }).webServer
  ctx.effect(() => {
    // The target port is read live so a harness config change is followed
    // (caddy restarts on HMR anyway).
    const target = config.targetPort ?? web.config.port ?? 3080
    const disposeRoutes = registerAssetRoutes(web, config)
    let handle: CaddyHandle | null = null
    let stopped = false

    void (async () => {
      try {
        const caddyPath = await ensureCaddyBinary(config.caddyPath === '' ? undefined : config.caddyPath)
        if (stopped) return
        handle = await startCaddy(caddyPath, { ...config, targetPort: target })
        if (stopped) {
          stopCaddy(handle)
          return
        }
        console.log(
          `[caddy-https] serving https://${config.host}:${config.port} → http://127.0.0.1:${target} `
          + `(self-signed; install the root CA from /plugins/caddy-https/root.crt to trust it)`,
        )
      } catch (error) {
        if (!stopped) {
          console.warn(`[caddy-https] not started: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    return () => {
      stopped = true
      disposeRoutes()
      if (handle !== null) stopCaddy(handle)
    }
  }, 'caddy-https teardown')
}
