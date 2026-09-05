# page-lazy

Client-side dsh web plugin that warms the conversation window's scroll-up
path with an idle prefetch.

## dsh 0.1.2 rewrite

The adaptive **page-size** half (first page 30 / later pages 50) was removed
in the 0.1.2 rewrite: the `session.history({maxMessages})` seam it wrapped no
longer exists (paging lives in a private `SessionEventStream` with a
hardcoded `PAGE_MESSAGES = 50`), and 0.1.2 packs streaming `assistant/chunk`
deltas natively (`@deepseek-ai/dsh-session/chunk-rows`, ~56× envelope
reduction in both persistence and history transport) — the page-weight
problem the size policy managed is gone. chunk-trim, whose trimming this
policy was designed on top of, was retired for the same reason.

What remains — and has no native equivalent — is the **lazy-load timing**:

- **Idle prefetch**: after a real cold→open transition, schedule ONE
  `loadOlder()` in idle (`requestIdleCallback`, 800 ms `setTimeout` fallback).
  It goes through the same anchor-preserving path as the manual button, so
  the reader's scroll position is untouched. It fires once per cold→open
  transition (`wasOpen` skip) and a reconnect resync re-arms it naturally, so
  the download is bounded to one page per open and never cascades.
- **Manual "load earlier" button** stays as the deep-dive affordance
  (`hasMore` keeps rendering it).
- **Scroll-proximity auto-load** (auto-trigger when the reader scrolls near
  the oldest loaded message) is deliberately *not* done here: the
  conversation scrollport is owned by the ChatView React component, which a
  client plugin cannot reach cleanly. It is an upstream/UI-layer change —
  follow-up.

Guards: prefetch only when `openState === "open"`, `hasMore`, and not already
`loadingOlder`; at most one page in flight (`loadingOlder` inside
`loadOlder`); no cascade.

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
  `session/page`, then, in idle, a second paged request with a `beforeSeq`.
