/**
 * Caddy lifecycle: binary provisioning (download + unpack), Caddyfile
 * generation, and start/stop around the proxy process.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface CaddyHandle {
  proc: ReturnType<typeof spawn>
}

export interface CaddyConfig {
  host: string
  port: number
  targetPort: number
}

/** Plugin data dir under the user home (survives harness reinstalls). */
export function dataDir(): string {
  return join(homedir(), '.dsh', 'caddy-https')
}

const BIN_PATH = join(dataDir(), 'caddy')
/** Fallback version when the GitHub API is unreachable (known-good release). */
const FALLBACK_VERSION = 'v2.9.1'

/** Map node platform/arch onto the caddy release asset tuple. */
function goTarget(): { goos: string; goarch: string } {
  const goos = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
  let goarch: string
  switch (process.arch) {
    case 'x64': goarch = 'amd64'; break
    case 'arm64': goarch = 'arm64'; break
    case 'arm': goarch = 'armv7'; break
    default: goarch = 'amd64'
  }
  return { goos, goarch }
}

/** Latest caddy release tag from the GitHub API, or the fallback on failure. */
async function latestVersion(): Promise<string> {
  try {
    const res = await fetch('https://api.github.com/repos/caddyserver/caddy/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-caddy-https' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return FALLBACK_VERSION
    const json = (await res.json()) as { tag_name?: string }
    return json.tag_name ?? FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * Return a usable caddy binary path: the explicit one when configured, an
 * already-downloaded one, otherwise fetch + unpack into ~/.dsh/caddy-https/.
 */
export async function ensureCaddyBinary(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && existsSync(explicit)) return explicit
  if (existsSync(BIN_PATH)) return BIN_PATH
  mkdirSync(dataDir(), { recursive: true })
  const { goos, goarch } = goTarget()
  const tag = await latestVersion()
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  const url = `https://github.com/caddyserver/caddy/releases/download/${tag}/caddy_${version}_${goos}_${goarch}.tar.gz`
  console.log(`[caddy-https] downloading caddy ${tag} (${goos}/${goarch}) …`)
  const tarball = join(dataDir(), 'caddy.tar.gz')
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`caddy download failed (${res.status}): ${url}`)
  if (res.body === null) throw new Error('caddy download: empty body')
  await pipeline(Readable.fromWeb(res.body as never), (await import('node:fs')).createWriteStream(tarball))
  const unpack = spawnSync('tar', ['xzf', tarball, '-C', dataDir()], { stdio: 'pipe' })
  if (unpack.status !== 0) throw new Error(`caddy unpack failed: ${unpack.stderr?.toString()}`)
  chmodSync(BIN_PATH, 0o755)
  return BIN_PATH
}

/** The Caddyfile: self-signed TLS on the public host, proxied to loopback.
 *  `skip_install_trust` stops Caddy from auto-installing its internal root
 *  into the system CA store — that path shells out to `sudo tee` and prompts
 *  for a password on every start. Trust is a deliberate per-device step. */
function caddyfile(cfg: CaddyConfig): string {
  return [
    '{',
    '\tadmin off',
    '\tauto_https disable_redirects',
    '\tskip_install_trust',
    '}',
    '',
    `https://${cfg.host}:${cfg.port} {`,
    '\ttls internal',
    `\treverse_proxy 127.0.0.1:${cfg.targetPort}`,
    '}',
    '',
  ].join('\n')
}

/**
 * Start caddy in the foreground (owned by this fiber). Resolves once the
 * HTTPS port answers; rejects on early exit or timeout.
 */
export async function startCaddy(caddyPath: string, cfg: CaddyConfig): Promise<CaddyHandle> {
  const cfgPath = join(dataDir(), 'Caddyfile')
  writeFileSync(cfgPath, caddyfile(cfg))
  const proc = spawn(caddyPath, ['run', '--config', cfgPath, '--adapter', 'caddyfile'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = (stream: 'out' | 'err', chunk: Buffer): void => {
    const line = chunk.toString().trim()
    if (line !== '') console.log(`[caddy-https] ${stream}: ${line}`)
  }
  proc.stdout?.on('data', (c: Buffer) => log('out', c))
  proc.stderr?.on('data', (c: Buffer) => log('err', c))

  return await new Promise<CaddyHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('caddy start timeout'))
    }, 20_000)
    proc.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`caddy exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
    })
    const probe = async (attempt: number): Promise<void> => {
      try {
        // A self-signed front rejects the TLS handshake — the connection
        // itself succeeding (cert error) proves caddy is up.
        await fetch(`https://127.0.0.1:${cfg.port}/`, {
          signal: AbortSignal.timeout(1500),
        })
        clearTimeout(timer)
        resolve({ proc })
      } catch (error) {
        const certRejected = error instanceof TypeError
          || (error instanceof Error && /certificate|self-signed|tls/i.test(error.message))
        if (certRejected) {
          clearTimeout(timer)
          resolve({ proc })
        } else if (attempt < 20) {
          setTimeout(() => void probe(attempt + 1), 400)
        } else {
          proc.kill()
          clearTimeout(timer)
          reject(new Error('caddy never accepted connections'))
        }
      }
    }
    setTimeout(() => void probe(0), 600)
  })
}

/** Stop the caddy process (SIGTERM, then SIGKILL if it lingers). */
export function stopCaddy(handle: CaddyHandle): void {
  const { proc } = handle
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill()
  const killer = setTimeout(() => proc.kill('SIGKILL'), 3000)
  proc.once('exit', () => clearTimeout(killer))
}

/** Path of Caddy's internal root CA (written after first `tls internal` use). */
export function rootCertPath(): string {
  return join(homedir(), '.local', 'share', 'caddy', 'pki', 'authorities', 'local', 'root.crt')
}
