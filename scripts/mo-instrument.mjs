// Instrument MutationObserver in the DSH page before any script runs,
// reload, simulate streaming churn, and dump per-observer stats.
const BROWSER_WS = process.argv[2]
const PAGE_URL = 'http://127.0.0.1:3080/'

const INIT_SOURCE = `
(() => {
  const stats = []
  const OrigMO = window.MutationObserver
  function WrappedMO(cb) {
    const rec = { calls: 0, records: 0, totalMs: 0, maxMs: 0, stack: (new Error('mo')).stack || '' }
    stats.push(rec)
    const wrapped = (mutations, obs) => {
      const t0 = performance.now()
      try { return cb.call(obs, mutations, obs) } finally {
        const dt = performance.now() - t0
        rec.calls++; rec.records += mutations.length; rec.totalMs += dt
        if (dt > rec.maxMs) rec.maxMs = dt
      }
    }
    return new OrigMO(wrapped)
  }
  WrappedMO.prototype = OrigMO.prototype
  window.MutationObserver = WrappedMO
  window.__moStats = stats
  window.__longtasks = []
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push(Math.round(e.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
})()
`

const CHURN = `
new Promise((resolve) => {
  const conv = document.querySelector('[data-conversation-scroll]')
  const target = (conv && (conv.lastElementChild || conv)) || document.body
  const start = performance.now()
  const ltStart = window.__longtasks.length
  let n = 0
  const timer = setInterval(() => {
    const span = document.createElement('span')
    span.textContent = ' token' + (n++)
    target.appendChild(span)
    if (n % 10 === 0) {
      const div = document.createElement('div')
      div.appendChild(document.createElement('p')).textContent = 'block ' + n
      target.appendChild(div)
    }
  }, 50)
  setTimeout(() => {
    clearInterval(timer)
    setTimeout(() => {
      resolve({
        churnWallMs: Math.round(performance.now() - start),
        newLongtasks: window.__longtasks.slice(ltStart),
      })
    }, 600)
  }, 6000)
})
`

const OPEN_SESSION = `
(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"][aria-selected]')]
  const row = rows.find(r => (r.textContent||'').includes('无法访问 codex'))
  if (row) { row.click(); return 'clicked' }
  return 'not-found: ' + rows.length
})()
`

const DUMP = `
JSON.stringify((window.__moStats || []).map(r => ({
  calls: r.calls, records: r.records,
  totalMs: Math.round(r.totalMs), maxMs: Math.round(r.maxMs),
  src: (r.stack.split('\\n').find(l => l.includes('.js')) || '').trim().slice(0, 160),
})), null, 1)
`

const res = await fetch(BROWSER_WS.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))
const targets = await res.json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith(PAGE_URL))
if (!page) { console.error('page target not found', targets.map(t => t.url)); process.exit(1) }

const ws = new WebSocket(BROWSER_WS)
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
  })
}

const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: page.id, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SOURCE }, sessionId)
await send('Page.reload', { ignoreCache: true }, sessionId)
await new Promise(r => setTimeout(r, 8000))

const open = await send('Runtime.evaluate', { expression: OPEN_SESSION, returnByValue: true }, sessionId)
console.log('open session:', open.result?.result?.value)
await new Promise(r => setTimeout(r, 6000))

const churn = await send('Runtime.evaluate', { expression: CHURN, awaitPromise: true, returnByValue: true }, sessionId)
console.log('churn:', JSON.stringify(churn.result?.result?.value))

const dump = await send('Runtime.evaluate', { expression: DUMP, returnByValue: true }, sessionId)
console.log('moStats:', dump.result?.result?.value)
ws.close()
process.exit(0)
