# msg-collapse

Client-side dsh web plugin that collapses **long user messages** (typically
large pasted text) in the conversation view, so one pasted wall of text no
longer dominates the chat.

## How it works

- The conversation renders user messages through the keyed slot
  `conversation.chat.node` (cell `"user"`). Slots shadow by priority —
  **lowest priority wins** — so this plugin registers a wrapper at
  `priority: -100` that takes over the cell.
- The wrapper does **not** replicate the bubble: it reads the built-in
  `UserMessageNodeView` component from `ctx.slots.entries(...)` and renders
  it unchanged inside a clamp layer. Copy action, images, links, JSON blocks,
  hover time — all stay intact.
- Only messages whose text exceeds `COLLAPSE_CHARS` (500) get the wrapper:
  a `max-height: 12em` clamp with a fade and a localized "展开全文 / Expand"
  pill. Click toggles to full text ("收起 / Collapse"). Normal messages
  render the built-in directly with zero extra DOM.
- Clicking a link, button, or image inside the bubble passes through (toggle
  is skipped for interactive targets and during text selection).

## Install

Same profile wiring as the other dev plugins (`~/.dsh/profiles/web`):

1. `package.json` dependencies: `"msg-collapse": "link:<src>/msg-collapse"`
2. `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: msg-collapse
         name: msg-collapse
   ```

3. `pnpm install`, then **restart `dsh web`** and refresh the browser (the
   modules node serves `/plugins/msg-collapse/client.js`; later edits of
   `lib/client.js` hot-swap via `dsh-client-hmr`).

## Verify

- Served bundle: `curl -s http://127.0.0.1:3080/plugins/msg-collapse/client.js`
- Behavior: send (or open a session containing) a user message with > 500
  characters of text — it renders collapsed with an expand pill; clicking
  expands/collapses. Short messages are unaffected.
