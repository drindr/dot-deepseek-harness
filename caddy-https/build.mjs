/**
 * Build script for caddy-https (mirrors the tailscale-patch pipeline).
 * Emits two artifacts:
 *  - lib/index.js — the Node/host half (ESM): caddy provisioning + HTTPS
 *    front + push API + event triggers. @deepseek-ai/* stays external.
 *  - lib/client.js — the browser half (module-loader bundle): service-worker
 *    registration + the notification toggle.
 */
import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function esbuildBinary() {
  const key = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
  const matches = globSync(`node_modules/.pnpm/@esbuild+${key}@*/node_modules/@esbuild/${key}/${exe}`)
  if (matches.length > 0) return matches[0]
  const fallback = globSync(`node_modules/@esbuild/${key}/${exe}`)
  if (fallback.length > 0) return fallback[0]
  throw new Error(`esbuild native binary not found for ${key} — run \`pnpm install\` first`)
}

function run(args) {
  const result = spawnSync(esbuildBinary(), args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function commitIfChanged(tmp, target) {
  let changed = true
  try {
    changed = !readFileSync(tmp).equals(readFileSync(target))
  } catch (_missingTarget) {
    changed = true
  }
  if (changed) writeFileSync(target, readFileSync(tmp))
  unlinkSync(tmp)
  return changed
}

/** Build the Node/host half into lib/index.js. @returns whether the artifact changed. */
export function buildHost() {
  mkdirSync('lib', { recursive: true })
  const tmp = `lib/index.tmp.${process.pid}.js`
  run([
    'src/index.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    '--external:@deepseek-ai/*',
    // ponytail: bundled CJS deps (web-push) call require("crypto"); define real require so esbuild's __require shim delegates
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    `--outfile=${tmp}`,
  ])
  return commitIfChanged(tmp, 'lib/index.js')
}

/** Build the browser half into lib/client.js (module-loader bundle). */
export function buildClient() {
  mkdirSync('lib', { recursive: true })
  const tmp = `lib/client.tmp.${process.pid}.js`
  run([
    'src/client/index.ts',
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2020',
    `--outfile=${tmp}`,
    '--banner:js=window.__ModuleLoader__.load({ id: "caddy-https", factory: function (require) { var module = { exports: {} }; var exports = module.exports;',
    '--footer:js=return module.exports; } });',
  ])
  return commitIfChanged(tmp, 'lib/client.js')
}

// CLI entry: `node build.mjs` (also keeps `pnpm run build` behavior).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHost()
  buildClient()
}
