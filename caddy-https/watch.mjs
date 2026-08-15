import { watch } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildHost } from './build.mjs'

const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms) } }
const rebuild = debounce(() => {
  try { if (buildHost()) console.log('[caddy-https] rebuilt lib/index.js') }
  catch (e) { console.error('[caddy-https] build failed:', e.message) }
}, 120)
watch('src', { recursive: true }, rebuild)
watch('build.mjs', rebuild)
console.log('[caddy-https] watching src/ (host HMR reloads the fiber on rebuild)')
