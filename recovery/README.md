# recovery

A dsh **host bundle** that opens a *recovery session*: a fresh, headless agent
session booted over a **minimal `dsh-base`-only tree**, so a broken plugin in
your dev workspace can never stop it from starting. Use it when a plugin you're
building breaks `dsh web` so badly that the web profile won't boot.

```
dsh --profile recovery                          # run the built-in recovery prompt
dsh --profile recovery "fix chunk-trim"         # or steer it at a specific plugin
```

## Why this exists

The `dsh` boot is transactional: every bundle layer and every entry in
`cordis.patch.yml` mounts together, and one plugin that throws during `apply`
(or whose module fails to import) fails the whole tree — `dsh web` prints a
`fatal load failure` and exits. The web profile (with all your dev plugins
wired in) is then unreachable, which is exactly when you want an agent to look
at the breakage.

`recovery` sidesteps the broken tree instead of fighting it. Its profile mounts
`dsh-base` (agent, session, fs/bash/edit tools, web search, subagents) plus two
tiny rows — a command-line provider and a one-shot runner — and **nothing else**:
no Host, no HTTP server, no Web runtime, no browser layer, and none of your dev
plugins. The runner opens one agent session and drives a recovery task to
quiescence, then prints the final assistant message and exits.

## Install

```bash
dsh plugin --profile recovery add link:/home/drin/workspace/dsh-plugin/recovery
```

`recovery` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so
`dsh plugin` reconciles it into the profile's layer stack automatically:
`dsh.profile.bundles` becomes `["@deepseek-ai/dsh-base", "recovery"]`. The
profile is created on first use; no manual `cordis.patch.yml` editing is needed.

## Usage

```bash
# Reproduce + fix whatever broke dsh web, using the built-in prompt:
dsh --profile recovery

# Target one plugin, or pass any task text (joined into a single prompt):
dsh --profile recovery "page-lazy broke startup, fix it"
```

The positional arguments are joined verbatim into the recovery task; a blank
invocation falls back to a built-in prompt that tells the agent to:

1. run `dsh web` (or `dsh --dump-config --profile web`) and read the exact
   startup error,
2. locate the failing loader entry id/name and its source under the workspace,
3. fix **only** files under the workspace (not core dsh / `~/.dsh`),
4. verify with `node --check` and another `dsh web` boot.

Because the tree is `dsh-base` only, the agent has the full tool surface
(bash, file read/write, edit, web search, subagents) but none of the dev
plugins that broke the web profile.

## How it works

`cordis.patch.yml` mirrors `@deepseek-ai/dsh-headless` over `dsh-base`:

- `system-prompt` persona and `tools` mode are restated; `hmr` is disabled.
- `code-runtime` (`@deepseek-ai/dsh-code-runtime-worker-thread`) is inserted so
  the agent can actually execute shell work.
- `recovery/startup` reads `ctx.cmdlineArgs` and publishes `recoveryStartup`.
- `recovery` (the runner) injects `agentDefaultModel` / `agents` / `sessions`,
  creates a fresh agent with the default model selection, submits the task as an
  ordinary user message, flushes the session, prints the final assistant text to
  stdout, and requests exit through the launcher's `ctx.appExit`
  (`turn/end completed → 0`, otherwise `1`).

The runner is deliberately **dependency-free** (only `node:crypto`): it drives
the host purely through injected services and hand-rolls the user message, so a
`link:`-installed workspace plugin never needs its own copy of the
`@deepseek-ai/*` package closure.

## Notes

- The recovery session is a **headless one-shot**: it prints the final answer
  and exits; it does not open a listening port or a browser UI. This is the
  surface that still exists when the web profile is down.
- If you run it without a task it will spend a real model turn reproducing the
  failure; to just sanity-check the tree, `dsh --dump-config --profile recovery`
  prints the composed layers without booting anything.
- Fixes are **not** applied to the broken web profile automatically — the agent
  edits your plugin sources under the workspace, then you restart `dsh web`.
