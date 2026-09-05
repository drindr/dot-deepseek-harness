/**
 * Loopback-client patch: make `@deepseek-ai/dsh-client-connection`'s browser
 * bundle treat this plugin's HTTPS front host as a loopback client.
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
 * dsh 0.1.2 rewrite — the old mechanism (an exact route shadowing
 * `/plugins/@deepseek-ai/dsh-client-connection/client.js` with patched bytes)
 * is dead: 0.1.2 serves ALL client bundles through combo URLs
 * (`/plugins/??<ids>&rev=<hash>`, composed in memory at composition time), so
 * the per-module path never carries executable code again.
 *
 * The 0.1.2 mechanism uses only official client-modules service methods:
 *
 *  1. Resolve the bundle path via `clientModules.clientPath(id)`.
 *  2. Rewrite the bytes on disk (one disjunct appended inside the anchor
 *     line), keeping a pristine backup at `<bundle>.caddy-pristine`.
 *  3. Call `clientModules.rebuilt(id)` — the documented "bundle content
 *     changed" entry point — which re-reads the file, re-hashes it,
 *     recomposes every combo from the patched bytes, and pushes the new
 *     graph to connected clients through the normal HMR channel.
 *
 * Drift behaviour: the anchor is a stable suffix that survived the
 * 0.1.1→0.1.2 rewrite (`transport?.ownsHost` was prepended upstream; the
 * suffix was untouched). If a future release removes even the suffix, the
 * patch logs a warning and leaves the bundle pristine instead of guessing.
 * A dsh upgrade reinstalls node_modules, so the patch self-heals by simply
 * being re-applied on the next activation.
 *
 * Source maps: the rewrite inserts text INSIDE one line (no newline added),
 * so mappings on that single line shift; every other line is unaffected.
 * Debug-only concern.
 *
 * Teardown restores the pristine bytes and triggers one more `rebuilt`, so
 * disabling the plugin returns the harness to an untouched tree.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'

/** Minimal structural face of the clientModules service (matches src/index.ts). */
interface ClientModulesLike {
  clientPath(id: string): string | undefined
  rebuilt(id: string): string | undefined
}

/** The client package whose bundle computes `connection.isLoopback`. */
const BUNDLE_ID = '@deepseek-ai/dsh-client-connection'

/**
 * Anchor suffix in the served bundle (single occurrence, verified against
 * dsh-client-connection 0.1.2-rc.1: the full line is
 * `isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`
 * but only this suffix is matched so upstream prepends do not drift the
 * patch). The rewrite appends one disjunct before the comma.
 */
const ANCHOR = '|| isLoopbackHostname(pageLocation.hostname),'

function patchedAnchor(host: string): string {
  return `|| isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === ${JSON.stringify(host)},`
}

/** Pristine backup path next to the bundle. */
function backupPath(file: string): string {
  return `${file}.caddy-pristine`
}

/**
 * Apply (or refresh) the on-disk rewrite, then trigger a client-modules
 * rebuild so the composed combos pick the patched bytes up.
 * @returns true when the served graph now carries the patch.
 */
async function applyPatch(clientModules: ClientModulesLike, host: string): Promise<boolean> {
  const file = clientModules.clientPath(BUNDLE_ID)
  if (file === undefined) {
    console.warn(`[caddy-https] loopback client patch: bundle ${BUNDLE_ID} not in the client module graph — patch disabled`)
    return false
  }
  const patched = patchedAnchor(host)
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    console.warn(`[caddy-https] loopback client patch: cannot read ${file}: ${String(error)}`)
    return false
  }
  if (source.includes(patched)) {
    // Already patched (re-activation after HMR). The running graph may still
    // predate the patch (e.g. dsh restarted with the file already patched) —
    // rebuilt() is rev-idempotent, so calling it unconditionally is cheap.
    clientModules.rebuilt(BUNDLE_ID)
    return true
  }
  if (!source.includes(ANCHOR)) {
    console.warn(
      '[caddy-https] loopback client patch: anchor not found in the connection bundle ' +
      '(upstream changed?) — leaving it pristine; settings surfaces will stay loopback-only',
    )
    return false
  }
  // Keep exactly one pristine copy: the backup is (re)made only while the
  // live file carries no patch, so it can never capture patched bytes.
  try {
    await copyFile(file, backupPath(file))
    await writeFile(file, source.replace(ANCHOR, patched))
  } catch (error) {
    console.warn(`[caddy-https] loopback client patch: cannot rewrite ${file}: ${String(error)}`)
    return false
  }
  const rev = clientModules.rebuilt(BUNDLE_ID)
  if (rev === undefined) {
    console.warn('[caddy-https] loopback client patch: rebuilt() returned undefined — graph not recomposed')
    return false
  }
  console.log(`[caddy-https] connection bundle patched: ${host} treated as loopback (rev ${rev})`)
  return true
}

/**
 * Restore the pristine bundle (if a backup exists) and recompose. Best-effort:
 * teardown must never throw into the fiber.
 */
async function revertPatch(clientModules: ClientModulesLike): Promise<void> {
  const file = clientModules.clientPath(BUNDLE_ID)
  if (file === undefined) return
  try {
    await copyFile(backupPath(file), file)
    clientModules.rebuilt(BUNDLE_ID)
    console.log('[caddy-https] connection bundle restored to pristine bytes')
  } catch {
    // No backup (never patched, or backup lost) — nothing to restore.
  }
}

/**
 * Apply the loopback patch against the live client-modules service.
 * @param clientModules - the client-modules registry (bundle paths + rebuilt).
 * @param host - the configured HTTPS front hostname (bare, no port).
 * @returns disposer restoring the pristine bundle.
 */
export function registerLoopbackClientPatch(
  clientModules: ClientModulesLike,
  host: string,
): () => void {
  let disposed = false
  void applyPatch(clientModules, host).catch((error) => {
    console.warn(`[caddy-https] loopback client patch failed: ${String(error)}`)
  })
  return () => {
    if (disposed) return
    disposed = true
    void revertPatch(clientModules).catch(() => {})
  }
}
