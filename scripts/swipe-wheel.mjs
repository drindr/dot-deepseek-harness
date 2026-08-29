// Horizontal wheel scroll (compositor-driven) across the pager.
const BROWSER_WS = process.argv[2]
const PAGE_URL = 'http://127.0.0.1:3080/'
const OPEN_SESSION = `
(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"][aria-selected]')]
  const row = rows.find(r => (r.textContent||'').includes('无法访问 codex'))
  if (row) { row.click(); return 'clicked' }
  return 'not-found'
})()
`
const res = await fetch(BROWSER_WS.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))
const targets = await res.json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith(PAGE_URL))
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
await send('Page.reload', { ignoreCache: true }, sid)
await new Promise(r => setTimeout(r, 8000))
console.log('open session:', await evalJs(OPEN_SESSION))
await new Promise(r => setTimeout(r, 6000))
await evalJs(`
(() => {
  window.__lt = []
  window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)) })
  window.__po.observe({ entryTypes: ['longtask'] })
  const frame = document.querySelector('div[data-sidebar-collapsed], div[data-details-collapsed]')
  frame.scrollLeft = frame.firstElementChild.offsetWidth
  return 'ok'
})()
`)
for (let i = 0; i < 20; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: -40, deltaY: 0 }, sid)
  await new Promise(r => setTimeout(r, 30))
  if (i % 5 === 4) console.log('wheel', i + 1, 'scrollLeft:', await evalJs(`document.querySelector('div[data-sidebar-collapsed], div[data-details-collapsed]').scrollLeft`))
}
await new Promise(r => setTimeout(r, 1200))
console.log('wheel swipe:', JSON.stringify(await evalJs(`(() => { window.__po.disconnect(); return { longtasks: window.__lt, total: window.__lt.reduce((a,b)=>a+b,0) } })()`)))
console.log('final scrollLeft:', await evalJs(`document.querySelector('div[data-sidebar-collapsed], div[data-details-collapsed]').scrollLeft`))
ws.close()
process.exit(0)
