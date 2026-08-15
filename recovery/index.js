/**
 * recovery — the recovery-runner host half (bundle main export).
 *
 * A one-shot direct Agent driver for the recovery profile: it mounts over
 * `dsh-base` only (no Host, HTTP server, Web runtime, or browser layer) and
 * opens ONE fresh agent session whose task is to recover dsh from a broken
 * plugin — reproduce the boot failure, locate the failing plugin, fix it, and
 * verify dsh starts again. The task comes from `ctx.recoveryStartup` (the
 * sibling `recovery/startup` row), falling back to a built-in recovery prompt
 * when `dsh --profile recovery` is invoked with no arguments.
 *
 * The driver is deliberately dependency-free (no `@deepseek-ai/*` imports):
 * it drives the host through the injected `agents` / `agentDefaultModel` /
 * `sessions` services only. Model routing uses the `agentOptions.provider` /
 * `agentOptions.model` from the default selection — the same pair the mutable
 * `installModelSelection` hook would install, unnecessary here because a
 * one-shot recovery session has no live model picker to re-route.
 *
 * @module recovery
 */
import { randomUUID } from "node:crypto";

/** Stable Cordis plugin name. */
export const name = "recovery-runner";

/** Core services required before the recovery turn can start. */
const inject = ["agentDefaultModel", "agents", "sessions"];
export { inject };

/** The process streams the runner writes to; tests substitute captures. */
const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Recursively freeze a message so later code cannot mutate shared identity. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Build one user-role message with a fresh stable id — the exact shape
 * `@deepseek-ai/dsh-llm`'s `createUserMessage` produces, hand-rolled so this
 * plugin needs no module imports beyond `node:crypto`.
 */
function createUserMessage(text) {
  return deepFreeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

/**
 * The built-in task used when `dsh --profile recovery` is run with no
 * arguments. The agent inherits full bash/fs/edit tools from `dsh-base`, so it
 * can reproduce the failure and repair the workspace on its own.
 */
function defaultTask(cwd) {
  return [
    "You are in a RECOVERY session. A plugin in the dsh plugin workspace broke",
    "the `dsh web` profile so it fails to start (or fails to reload). Diagnose it,",
    "fix it, and verify dsh boots again.",
    "",
    "Your working directory is " + cwd + " (the dev plugins live here, one",
    "directory per plugin). Do the following:",
    "",
    "1. Reproduce: run `dsh web` (or `dsh --dump-config --profile web`) and read",
    "   the exact startup error. The error names the loader entry id/name that",
    "   failed to load or activate.",
    "2. Locate the broken plugin under the workspace and read its source",
    "   (index.js / lib/index.js / lib/client.js, package.json, cordis.patch.yml).",
    "3. Fix ONLY files under this workspace. Do not edit core dsh or ~/.dsh",
    "   unless that is genuinely the broken layer; prefer fixing the plugin source.",
    "4. Verify: run `node --check` on the changed file(s), then `dsh web` again",
    "   and confirm it starts (or at least that the entry loads).",
    "",
    "Report exactly what was broken and the change that fixed it."
  ].join("\n");
}

/**
 * Aggregate the last assistant text and turn outcome in one owned interval.
 * @param events - the durable session events to summarize.
 * @param firstSeq - the sequence boundary of this recovery turn.
 * @returns the final text and turn-end reason.
 */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/**
 * Run one recovery task through a freshly created Agent and request exit.
 * @param ctx - plugin context carrying the Agent, default model, and Session services.
 * @param config - validated config; `task` is the recovery prompt.
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  const task = typeof config.task === "string" && config.task.trim() !== ""
    ? config.task
    : defaultTask(process.cwd());
  agent.followup(createUserMessage(task));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(outcome.text + "\n");
  if (outcome.reason?.kind === "error") {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

/**
 * Mount the one-shot recovery driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated config carrying the recovery task.
 */
export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === void 0) {
    throw new Error("recovery-runner: the launcher must provide ctx.appExit before the tree mounts");
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit };
  run(ctx, config ?? {}, io).catch((error) => {
    fail(io, error);
  });
}
