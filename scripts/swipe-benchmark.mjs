// Measure the dsh-mobile pager swipe (right-swipe to sidebar page):
// baseline vs 3D-flip disabled vs 3D+clip+shadow disabled.
const BROWSER_WS = process.argv[2]
const PAGE_URL = 'http://127.0.0.1:3080/'

const INIT_SOURCE = `
(() => {
  window.__longtasks = []
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push(Math.round(e.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
  const origAdd = EventTarget.prototype.addEventListener
  window.__scrollListeners = []
  EventTarget.prototype.addEventListener = function(type, listener, opts) {
    if (type === 'scroll' && typeof listener === 'function') {
      const rec = { calls: 0, totalMs: 0, maxMs: 0, stack: (new Error('l')).stack || '' }
      window.__scrollListeners.push(rec)
      const wrapped = function(ev) {
        const t0 = performance.now()
        try { return listener.call(this, ev) } finally {
          const dt = performance.now() - t0
          rec.calls++; rec.totalMs += dt; if (dt > rec.maxMs) rec.maxMs = dt
        }
      }
      return origAdd.call(this, type, wrapped, opts)
    }
    return origAdd.call(this, type, listener, opts)
  }
})()
`

const OPEN_SESSION = `
(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"][aria-selected]')]
  const row = rows.find(r => (r.textContent||'').includes('无法访问 codex'))
  if (row) { row.click(); return 'clicked' }
  return 'not-found: ' + rows.length
})()
`

// One swipe: chat page -> sidebar page -> back, rAF-driven over 700ms each way.
const SWIPE = `
new Promise((resolve) => {
  const frame = document.querySelector('div[data-sidebar-collapsed], div[data-details-collapsed]')
  if (!frame) return resolve({ error: 'no frame' })
  const chatLeft = frame.firstElementChild.offsetWidth || 0
  const ltStart = window.__longtasks.length
  const gaps = []
  let last = performance.now()
  // sidebar mutation counter
  let sidebarMutations = 0
  const mo = new MutationObserver((recs) => { sidebarMutations += recs.length })
  mo.observe(frame.firstElementChild, { childList: true, subtree: true, attributes: true, characterData: true })
  function animate(from, to, dur) {
    return new Promise((done) => {
      const start = performance.now()
      function step(now) {
        const t = Math.min(1, (now - start) / dur)
        frame.scrollLeft = from + (to - from) * t
        gaps.push(Math.round(now - last)); last = now
        if (t < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  }
  frame.scrollLeft = chatLeft
  last = performance.now()
  animate(chatLeft, 0, 700)
    .then(() => animate(0, chatLeft, 700))
    .then(() => setTimeout(() => {
      mo.disconnect()
      gaps.shift()
      resolve({
        chatLeft,
        longtasks: window.__longtasks.slice(ltStart),
        longtaskTotalMs: window.__longtasks.slice(ltStart).reduce((a,b)=>a+b,0),
        maxGap: Math.max(...gaps),
        avgGap: Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length),
        sidebarMutations,
      })
    }, 500))
})
`

const SET_STYLE = (id, css) => `
(() => {
  document.getElementById('${id}')?.remove()
  if (${JSON.stringify(css)} !== '') {
    const s = document.createElement('style')
    s.id = '${id}'
    s.textContent = ${JSON.stringify(css)}
    document.head.append(s)
  }
  return 'ok'
})()
`

const NO_3D = `
[data-dsh-mobile] div[data-sidebar-collapsed] > :nth-child(2),
[data-dsh-mobile] div[data-details-collapsed] > :nth-child(2) {
  transform: none !important;
  will-change: auto !important;
  transform-style: flat !important;
  backface-visibility: visible !important;
}
`
const NO_3D_CLIP_SHADOW = NO_3D + `
[data-dsh-mobile] div[data-sidebar-collapsed] > :nth-child(2),
[data-dsh-mobile] div[data-details-collapsed] > :nth-child(2) {
  border-radius: 0 !important;
  overflow: visible !important;
  box-shadow: none !important;
}
`

const DUMP = `
JSON.stringify({
  scrollListeners: (window.__scrollListeners || []).map(r => ({
    calls: r.calls, totalMs: Math.round(r.totalMs), maxMs: Math.round(r.maxMs),
    src: (r.stack.split('\\n').find(l => l.includes('.js')) || '').trim().slice(0, 140),
  })),
}, null, 1)
`

const res = await fetch(BROWSER_WS.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))
const targets = await res.json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith(PAGE_URL))
if (!page) { console.error('page target not found'); process.exit(1) }

const ws = new WebSocket(BROWSER_WS)
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
  })
}
async function evalJs(expr, awaitP = false) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: awaitP, returnByValue: true }, sid)
  return r.result?.result?.value
}

const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId: page.id, flatten: true })
await send('Page.enable', {}, sid)
await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SOURCE }, sid)
await send('Page.reload', { ignoreCache: true }, sid)
await new Promise(r => setTimeout(r, 8000))

console.log('open session:', await evalJs(OPEN_SESSION))
await new Promise(r => setTimeout(r, 6000))

console.log('A baseline     :', JSON.stringify(await evalJs(SWIPE, true)))
await new Promise(r => setTimeout(r, 800))

await evalJs(SET_STYLE('dshm-test', NO_3D))
await new Promise(r => setTimeout(r, 300))
console.log('B no 3D flip   :', JSON.stringify(await evalJs(SWIPE, true)))
await new Promise(r => setTimeout(r, 800))

await evalJs(SET_STYLE('dshm-test', NO_3D_CLIP_SHADOW))
await new Promise(r => setTimeout(r, 300))
console.log('C no 3D/clip/shadow:', JSON.stringify(await evalJs(SWIPE, true)))

await evalJs(SET_STYLE('dshm-test', ''))
console.log('scroll listeners:', await evalJs(DUMP))
ws.close()
process.exit(0)
