# chunk-trim

Host-side dsh web plugin that fixes slow session loading caused by the
`assistant/chunk` flood in history pages.

## Problem

Opening a session in the dsh web GUI issues one `session.history
{maxMessages: 50}` call. The server pages the **whole raw event window**
between the oldest page message and the tail, and that window is dominated by
token-sized streaming `assistant/chunk` events (`reasoning-delta`,
`text-delta`, `tool-call-delta`). With a reasoning-capable model
(e.g. `deepseek-v4-flash` + `reasoningEffort: high`), a single 50-message
page measured **15,000–41,000 events / 3.5–7.8 MB of JSON**, ~94% of it
token-delta chunks. The client must download, parse and fold all of them on
every open and every "load older" page — that is the perceived slowness.

## What the plugin does

Wraps the host's public `ctx.apiProxy.sessions.history` and
`ctx.apiProxy.subagents.history` (the RPC dispatcher resolves the method at
invoke time, so every transport picks up the wrapper) and removes the
token-delta chunk events from each response page:

- dropped: `assistant/chunk` with `chunk.type` ∈ {`reasoning-delta`,
  `text-delta`, `tool-call-delta`}, except the **first and last event of the
  page** — boundaries are kept so the client's `loadOlder` contiguity check
  (`tail seq + 1 === baseSeq`) keeps passing across pages;
- kept: everything else — messages, tool call/result, step/turn boundaries,
  and the sparse non-delta chunks (`block-start`/`block-end`/`usage`/`finish`,
  a few hundred per page at most).

Result: a 50-message page drops from ~41k events / 7.8 MB to a few hundred
events / well under 1 MB.

## Trade-off

The conversation view is built from `assistant/message` content, so completed
steps render unchanged. The only degradation: the trajectory panel loses
per-token detail for **non-final / interrupted** steps (their partial text is
rebuilt from delta chunks). Live streaming is unaffected — the mux still
delivers every chunk event.

## Install

In the `dsh web` profile (`~/.dsh/profiles/web`), using the portable
`$DSH_HOME/plugins` convention (no absolute paths in the profile config —
the symlinks below are the only machine-specific step):

1. expose the plugin packages under `$DSH_HOME/plugins` (source checkout can
   live anywhere):

   ```bash
   PLUGIN_SRC=/path/to/dot-deepseek-harness
   mkdir -p "$HOME/.dsh/plugins/@dsh-external"
   ln -s "$PLUGIN_SRC/chunk-trim" "$HOME/.dsh/plugins/chunk-trim"
   ln -s "$PLUGIN_SRC/ThreadTrail/threadtrail-server" "$HOME/.dsh/plugins/threadtrail-server"
   ln -s "$PLUGIN_SRC/ThreadTrail/threadtrail-client" "$HOME/.dsh/plugins/threadtrail-client"
   ln -s "$PLUGIN_SRC/dsh-terminal" "$HOME/.dsh/plugins/dsh-terminal"
   ln -s "$PLUGIN_SRC/dsh-mobile" "$HOME/.dsh/plugins/@dsh-external/dsh-mobile"
   ```

2. add the relative `link:`/`file:` specs to `~/.dsh/profiles/web/package.json`
   dependencies (resolved against `~/.dsh/profiles/web`, so `../../plugins/…`
   lands in `$DSH_HOME/plugins`):

   ```json
   "dependencies": {
     "@dsh-external/dsh-mobile": "link:../../plugins/@dsh-external/dsh-mobile",
     "chunk-trim": "link:../../plugins/chunk-trim",
     "dsh-terminal": "link:../../plugins/dsh-terminal",
     "threadtrail-client": "file:../../plugins/threadtrail-client",
     "threadtrail-server": "file:../../plugins/threadtrail-server"
   }
   ```

   (`@dsh-external/dsh-mobile` also joins `dsh.profile.bundles` — it declares
   `dsh.bundle.patch`.)

3. add to `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: chunk-trim
         name: chunk-trim
       - id: threadtrail-server
         name: threadtrail-server
       - id: threadtrail-client
         name: threadtrail-client
       - id: terminal
         name: dsh-terminal
   ```

4. `pnpm install` in the profile dir, then **restart `dsh web`** — a brand-new
   plugin needs a full profile reload to mount. (Host-side HMR only hot-swaps
   source changes of plugins that are *already mounted*; it does not reload
   `cordis.patch.yml`, which lives under the dot-directory `~/.dsh` that the
   hmr row's default `**/.*` ignore excludes.)

## Verify

```bash
curl -s -X POST http://127.0.0.1:3080/api/session.history \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"probe","method":"session.history","payload":{"sessionId":"<id>","maxMessages":50}}' \
  | wc -c
```

Before: ~3.5–7.8 MB. After: a few hundred KB.
