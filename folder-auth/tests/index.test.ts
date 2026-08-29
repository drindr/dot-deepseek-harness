import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResolveWrapper } from "../src/index.ts";
import type { FolderGrant, SessionLike } from "../src/paths.ts";

function evt(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data };
}

function session(id: string, events: unknown[] = [], parentSession?: string): SessionLike {
  return { id, events: events as SessionLike["events"], header: parentSession === undefined ? {} : { parentSession } };
}

test("makeResolveWrapper appends granted roots under workspace-write", () => {
  const s = session("s1", [evt("sandbox/folder-root", { op: "add", path: "/mnt/data" })]);
  const sessions = new Map<string, SessionLike>([["s1", s]]);
  const resolve = () => ({ mode: "workspace-write", workspaceRoot: "/ws" });
  const wrapped = makeResolveWrapper({ resolve, sessions });
  assert.deepEqual(wrapped({ session: s }), {
    mode: "workspace-write",
    workspaceRoot: "/ws",
    extraWritableRoots: ["/mnt/data"],
  });
});

test("makeResolveWrapper leaves non-workspace-write policies untouched", () => {
  const resolve = () => ({ mode: "read-only", workspaceRoot: "/ws" });
  const wrapped = makeResolveWrapper({ resolve, sessions: new Map() });
  assert.deepEqual(wrapped({ session: session("s1") }), { mode: "read-only", workspaceRoot: "/ws" });
});

test("makeResolveWrapper leaves policy untouched when there are no grants", () => {
  const resolve = () => ({ mode: "workspace-write", workspaceRoot: "/ws" });
  const wrapped = makeResolveWrapper({ resolve, sessions: new Map() });
  assert.deepEqual(wrapped({ session: session("s1") }), { mode: "workspace-write", workspaceRoot: "/ws" });
});

test("makeResolveWrapper leaves policy untouched when there is no session", () => {
  const resolve = () => ({ mode: "workspace-write", workspaceRoot: "/ws" });
  const wrapped = makeResolveWrapper({ resolve, sessions: new Map() });
  assert.deepEqual(wrapped({}), { mode: "workspace-write", workspaceRoot: "/ws" });
});

test("makeResolveWrapper preserves existing extraWritableRoots", () => {
  const s = session("s1", [evt("sandbox/folder-root", { op: "add", path: "/granted" })]);
  const sessions = new Map<string, SessionLike>([["s1", s]]);
  const resolve = () => ({ mode: "workspace-write", workspaceRoot: "/ws", extraWritableRoots: ["/existing"] });
  const wrapped = makeResolveWrapper({ resolve, sessions });
  assert.deepEqual(wrapped({ session: s }), {
    mode: "workspace-write",
    workspaceRoot: "/ws",
    extraWritableRoots: ["/existing", "/granted"],
  });
});

test("makeResolveWrapper uses the injected resolveNodes hook", () => {
  const s = session("s1", [evt("sandbox/folder-root", { op: "add", path: "/granted" })]);
  const sessions = new Map<string, SessionLike>([["s1", s]]);
  const resolve = () => ({ mode: "workspace-write", workspaceRoot: "/ws" });
  const resolveNodes = (grant: FolderGrant): string[] => [`${grant.path}/sub`];
  const wrapped = makeResolveWrapper({ resolve, sessions, resolveNodes });
  assert.deepEqual(wrapped({ session: s }).extraWritableRoots, ["/granted/sub"]);
});
