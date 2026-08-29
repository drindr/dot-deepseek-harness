// CPU-profile the streaming-churn scenario and aggregate self time by function.
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

const CHURN = `
new Promise((resolve) => {
  const conv = document.querySelector('[data-conversation-scroll]')
  const target = (conv && (conv.lastElementChild || conv)) || document.body
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
  setTimeout(() => { clearInterval(timer); setTimeout(resolve, 400) }, 6000)
})
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

await send('Profiler.enable', {}, sid)
await send('Profiler.start', {}, sid)
await evalJs(CHURN, true)
const { result: stopRes } = await send('Profiler.stop', {}, sid)
const prof = stopRes.profile

// Aggregate self time by function (microseconds per node hit count * interval).
const nodes = new Map()
for (const n of prof.nodes) nodes.set(n.id, n)
const selfHits = new Map()
for (const id of prof.samples ?? []) selfHits.set(id, (selfHits.get(id) || 0) + 1)
const interval = prof.timeDeltas ? Math.round(prof.timeDeltas.reduce((a, b) => a + b, 0) / prof.timeDeltas.length) : 1000
const agg = new Map()
for (const [nodeId, hits] of selfHits) {
  const n = nodes.get(nodeId)
  if (!n) continue
  const f = n.callFrame
  const name = `${f.functionName || '(anon)'} @ ${(f.url || '').replace(/^.*\//, '')}:${f.lineNumber}`
  agg.set(name, (agg.get(name) || 0) + hits * interval)
}
const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
for (const [name, us] of top) console.log(`${(us / 1000).toFixed(0).padStart(6)}ms  ${name}`)
ws.close()
process.exit(0)
