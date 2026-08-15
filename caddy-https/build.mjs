/**
 * Build script for caddy-https (mirrors the tailscale-patch pipeline).
 * Emits one ESM host artifact (lib/index.js); @deepseek-ai/* stays external
 * so it resolves through the profile's node_modules at runtime.
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
    `--outfile=${tmp}`,
  ])
  return commitIfChanged(tmp, 'lib/index.js')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHost()
}
