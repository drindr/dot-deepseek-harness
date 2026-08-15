# page-lazy

Client-side dsh web plugin that designs the conversation window's **page
size** and **lazy-load timing** on top of the chunk-trim host fix.

## Design

After chunk-trim, a 50-message history page is ~372 events / ~650 KB and the
server answers in ~130 ms — per-page cost is no longer the problem, so the
levers are *when* and *how much* the browser pulls.

### 1. Page sizes

| phase | messages/page | why |
|---|---|---|
| first open | **30** | fast first paint (~260 events / ~440 KB post-trim); the viewport only shows ~10–15 messages anyway |
| every later page (`loadOlder`, live re-pull) | **50** | fewer round trips for deep scrolls |

Discriminator: `beforeSeq === undefined && window empty` ⇒ true first open
(30). Everything else — including `doOpen`'s re-pull after a live update,
which has no `beforeSeq` but a non-empty window — keeps 50 so an installed
window is never shrunk.

### 2. Lazy-load timing

- **Idle prefetch**: after a real cold→open transition, schedule ONE
  `loadOlder()` in idle (`requestIdleCallback`, 800 ms `setTimeout` fallback).
  It goes through the same anchor-preserving path as the manual button, so
  the reader's scroll position is untouched. It self-disarms (fires only
  while `events.length < 30 + 50`), so the download never cascades.
- **Manual "load earlier" button** stays as the deep-dive affordance
  (`hasMore` keeps rendering it).
- **Scroll-proximity auto-load** (auto-trigger when the reader scrolls near
  the oldest loaded message) is deliberately *not* done here: the
  conversation scrollport is owned by the ChatView React component, which a
  client plugin cannot reach cleanly. It is an upstream/UI-layer change —
  follow-up.

### 3. Guards / coalescing

- At most one page in flight (`loadingOlder` flag inside `loadOlder`).
- Prefetch only when idle, `openState === "open"`, `hasMore`, and the window
  is still below `FIRST_PAGE + PAGE_SIZE`.
- No prefetch cascade; reconnect (`resync`) re-arms naturally.

## Install

Same profile wiring as the other dev plugins (`~/.dsh/profiles/web`):

1. `package.json` dependencies: `"page-lazy": "link:<src>/page-lazy"`
2. `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: page-lazy
         name: page-lazy
   ```

3. `pnpm install`, then **restart `dsh web`** (new plugin mount) and refresh
   the browser (the modules node then serves
   `/plugins/page-lazy/client.js`; `dsh-client-hmr` hot-swaps later edits of
   `lib/client.js` without a restart).

## Verify

- Served bundle: `curl -s http://127.0.0.1:3080/plugins/page-lazy/client.js`
- Behavior (browser devtools network tab): opening a session issues one
  `session.history` with `maxMessages: 30`, then, in idle, a second with
  `beforeSeq` + `maxMessages: 50`.
