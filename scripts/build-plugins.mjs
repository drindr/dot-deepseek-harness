// Unified build driver. Each plugin OWNS its build: the exact command lives
// in that plugin's package.json "scripts.build" (tsdown / node build.mjs /
// whatever it declares). This script does not hardcode per-plugin commands —
// it just runs every src-only plugin's own build script, because lib/ is a
// gitignored artifact that goes stale silently (dsh-mobile once shipped a
// 5-line placeholder apply() {} whose manifest/icon routes 404'd with no
// error anywhere).
//
//   node scripts/build-plugins.mjs
//
// --config.verify-deps-before-run=false disables pnpm's pre-run deps-status
// check, which otherwise shells out to `pnpm install` (needs the
// workspace-local store and a TTY).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// src-only plugins whose gitignored lib/ must be rebuilt after checkout/pull.
const PLUGINS = ['caddy-https', 'dsh-terminal', 'dsh-mobile', 'dsh-rerun']

let failed = false
for (const dir of PLUGINS) {
  const pkgPath = join(root, dir, 'package.json')
  if (!existsSync(pkgPath)) {
    console.warn(`[build-plugins] skip ${dir}: not present`)
    continue
  }
  const build = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.build
  if (!build) {
    console.warn(`[build-plugins] skip ${dir}: no "build" script declared`)
    continue
  }
  console.log(`[build-plugins] ${dir}: ${build}`)
  const result = spawnSync(
    'pnpm',
    ['--dir', join(root, dir), '--config.verify-deps-before-run=false', 'run', 'build'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.error(`[build-plugins] FAILED: ${dir} (status ${result.status})`)
    failed = true
  }
}

if (failed) {
  console.error('[build-plugins] one or more builds failed')
  process.exitCode = 1
} else {
  console.log('[build-plugins] all builds done')
}
