// folder-auth — src/index.ts
//
// Per-session folder authorization for the workspace-write sandbox. Mirrors
// flash-device-auth's mechanism, but the authorized object is an arbitrary
// absolute directory path instead of a device node.
//
// Semantics:
//   - Authorization is SESSION-scoped: `sandbox/folder-root` events live in
//     the session's durable log; a new session starts with none.
//   - Subagents INHERIT along the parentSession chain (union of grants).
//   - A grant is an absolute directory path — resolved to itself (no stat, no
//     allowlist, per the design doc's "truly arbitrary" security model).
//   - Revocation: `/fsauth remove|clear`, or the session ending.
//   - Anything not authorized behaves exactly as before (deny → human flow).

import {
  collectGrants,
  extraRootsFor,
  parseGrantToken,
  resolveGrantedPaths,
  type FolderGrant,
  type SessionLike,
  type SessionsLike,
} from "./paths.ts";

export const name = "folder-auth";
const inject = ["sandboxPolicy", "sessions"];

export { inject };

const WRAPPED = Symbol("folder-auth:resolve-wrapped");

// ── minimal harness types (cordis glue; core logic is fully typed in paths.ts) ──

interface ResolveRequest {
  session?: SessionLike;
  [key: string]: unknown;
}

interface Policy {
  mode?: string;
  workspaceRoot?: string;
  extraWritableRoots?: string[];
  [key: string]: unknown;
}

interface SandboxPolicyService {
  resolve: (request: ResolveRequest) => Policy;
}

interface SessionWithAppend extends SessionLike {
  append(type: string, data: unknown): unknown;
}

interface Agent {
  session: SessionWithAppend;
}

interface CommandResult {
  kind: string;
  text: string;
}

interface Context {
  sandboxPolicy?: SandboxPolicyService;
  sessions: SessionsLike;
  effect(callback: () => () => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- harness DI types are unavailable; the injected ctx is structural/loose
  inject(deps: string[], callback: (ctx: any) => void): unknown;
}

// ── resolve wrap ────────────────────────────────────────────────────────────

/**
 * Build the wrapped `resolve` for the sandbox-policy service. Pure and
 * dependency-injected for testing.
 */
export function makeResolveWrapper(options: {
  resolve: (request: ResolveRequest) => Policy;
  sessions: SessionsLike;
  resolveNodes?: (grant: FolderGrant) => string[];
}): (request?: ResolveRequest) => Policy {
  const { resolve, sessions, resolveNodes = resolveGrantedPaths } = options;
  return (request: ResolveRequest = {}) => {
    const policy = resolve(request);
    const session = request.session;
    // extra roots only have meaning under workspace-write confinement
    if (session === undefined || policy.mode !== "workspace-write") return policy;
    const extra = extraRootsFor(sessions, session, resolveNodes);
    if (extra.length === 0) return policy;
    return { ...policy, extraWritableRoots: [...(policy.extraWritableRoots ?? []), ...extra] };
  };
}

function wrapResolve(ctx: Context): void {
  const service = ctx.sandboxPolicy;
  if (service === undefined) return;
  const wrapped = service as SandboxPolicyService & { [WRAPPED]?: boolean };
  if (wrapped[WRAPPED]) return;
  wrapped[WRAPPED] = true;
  const original = wrapped.resolve;
  wrapped.resolve = makeResolveWrapper({
    resolve: (request) => original.call(wrapped, request),
    sessions: ctx.sessions,
  });
  // HMR-safe: on plugin reload, restore the pristine resolve and clear the
  // flag so the fresh plugin instance re-wraps with its own (current) code.
  ctx.effect(() => () => {
    wrapped.resolve = original;
    wrapped[WRAPPED] = false;
  });
}

// ── /fsauth command ─────────────────────────────────────────────────────────

/** Lossless-JSON event payload for one grant (no undefined values). */
function grantEventData(op: "add" | "remove", grant: FolderGrant): { op: string; path: string } {
  return { op, path: grant.path };
}

function registerCommands(ctx: Context): void {
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "fsauth",
      description: "Authorize folders for THIS session (folder-auth)",
      input: { hint: "add|remove|list|clear <absolute-path>" },
      handler: ({ agent, rawInput }: { agent: Agent; rawInput: string }): CommandResult => {
        const session = agent.session;
        const [op, ...rest] = rawInput.trim().split(/\s+/);
        const token = rest.join(" ");
        const result = (kind: string, text: string): CommandResult => ({ kind, text });

        if (op === "list") {
          const grants = collectGrants(ctx.sessions, session);
          const roots = extraRootsFor(ctx.sessions, session);
          const lines = [
            `authorized this session: ${grants.map((g) => g.path).join(", ") || "(none)"}`,
            `resolved roots: ${roots.join(", ") || "(none)"}`,
          ];
          return result("success", lines.join("\n"));
        }
        if (op === "clear") {
          session.append("sandbox/folder-root", { op: "clear" });
          return result("success", "all folder grants cleared for this session");
        }
        if (op !== "add" && op !== "remove") {
          return result("error", "usage: /fsauth add|remove|list|clear <absolute-path>");
        }
        if (token === "") {
          return result("error", "missing path (use an absolute directory path)");
        }
        const parsed = parseGrantToken(token);
        if ("error" in parsed) return result("error", parsed.error);
        session.append("sandbox/folder-root", grantEventData(op, parsed.grant));
        return result("success", op === "add"
          ? `authorized for this session: ${parsed.grant.path}`
          : `revoked for this session: ${parsed.grant.path}`);
      },
    });
  });
}

// ── system-prompt context ───────────────────────────────────────────────────

function injectPromptContext(ctx: Context): void {
  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.context({
      name: "folder-auth:policy",
      order: 117,
      text: (context: { agent?: Agent }) => {
        const agent = context.agent;
        if (agent === undefined) return "";
        const grants = collectGrants(ctx.sessions, agent.session);
        if (grants.length === 0) {
          return `Folder access: NONE authorized for this session. If a write to a folder outside the workspace fails under the sandbox, ask the USER to run \`/fsauth add <absolute-path>\` to authorize that folder for THIS session only. NOTE: /fsauth accepts ANY absolute path (no allowlist) — granting is a user decision; never ask the user to authorize sensitive locations.`;
        }
        return `Folder access: authorized for this session: ${grants.map((g) => g.path).join(", ")}. Writes inside these folders are allowed under workspace-write; do not escalate for them.`;
      },
    });
  });
}

// ── plugin ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config?: unknown): void {
  wrapResolve(ctx);
  registerCommands(ctx);
  injectPromptContext(ctx);
}
