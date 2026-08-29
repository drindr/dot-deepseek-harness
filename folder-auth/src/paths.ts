// folder-auth — src/paths.ts
//
// Pure folder-grant logic. A grant is a single absolute directory path. The
// fold reads `sandbox/folder-root` events from the session log; resolution is
// deliberately a no-op (the path IS the grant) — no existence check, no
// sensitive-path filtering (see the design doc's security model).

export interface FolderGrant {
  path: string;
}

export interface SessionLike {
  id: string;
  events?: unknown[];
  header?: { parentSession?: string };
}

/** A session log entry, structurally: { type, data }. */
interface LogEvent {
  type?: string;
  data?: Record<string, unknown>;
}

export interface SessionsLike {
  get(id: string): SessionLike | undefined;
}

const EVENT_TYPE = "sandbox/folder-root";

/**
 * Parse one `/fsauth` token. The ONLY validation is the form requirement that
 * a grant be an absolute path (bwrap `--bind` needs one, and `/` itself cannot
 * be bound over the sandbox root) — not a security filter.
 */
export function parseGrantToken(token: string): { grant: FolderGrant } | { error: string } {
  if (!token.startsWith("/") || token.length <= 1) {
    return { error: "expected an absolute directory path (e.g. /mnt/data)" };
  }
  return { grant: { path: token } };
}

/** Stable identity key for one grant: `path:<path>`. */
export function grantKey(grant: FolderGrant): string {
  return `path:${grant.path}`;
}

/**
 * Fold `sandbox/folder-root` events (log order) into the current grants.
 * `{op:"add", path}` / `{op:"remove", path}` mutate; `{op:"clear"}` empties.
 * Malformed entries (non-string / non-absolute path, unknown op) are ignored.
 */
export function foldFolderGrants(events?: unknown[]): FolderGrant[] {
  const state = new Map<string, FolderGrant>();
  for (const event of (events ?? []) as LogEvent[]) {
    if (event?.type !== EVENT_TYPE) continue;
    const data = event.data ?? {};
    if (data.op === "clear") {
      state.clear();
      continue;
    }
    if (data.op !== "add" && data.op !== "remove") continue;
    if (typeof data.path !== "string") continue;
    if (!data.path.startsWith("/") || data.path.length <= 1) continue;
    const grant: FolderGrant = { path: data.path };
    const key = grantKey(grant);
    if (data.op === "add") state.set(key, grant);
    else state.delete(key);
  }
  return [...state.values()];
}

/** Union of grants along the parentSession chain (own session included). */
export function collectGrants(sessions: SessionsLike, session: SessionLike): FolderGrant[] {
  const grants: FolderGrant[] = [];
  const seen = new Set<string>();
  let current: SessionLike | undefined = session;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    grants.push(...foldFolderGrants(current.events));
    const parentId: string | undefined = current.header?.parentSession;
    current = parentId === undefined ? undefined : sessions.get(parentId);
  }
  return grants;
}

/** A grant resolves to its own path — no stat, no filtering (fail-closed upstream). */
export function resolveGrantedPaths(grant: FolderGrant): string[] {
  return [grant.path];
}

/** Resolved, deduplicated writable roots for a session's inherited grants. */
export function extraRootsFor(
  sessions: SessionsLike,
  session: SessionLike,
  resolveNodes: (grant: FolderGrant) => string[] = resolveGrantedPaths,
): string[] {
  const grants = new Map<string, FolderGrant>();
  for (const grant of collectGrants(sessions, session)) {
    grants.set(grantKey(grant), grant);
  }
  const roots: string[] = [];
  for (const grant of grants.values()) roots.push(...resolveNodes(grant));
  return [...new Set(roots)];
}
