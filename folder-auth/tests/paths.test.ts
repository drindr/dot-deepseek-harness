import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectGrants,
  extraRootsFor,
  foldFolderGrants,
  grantKey,
  parseGrantToken,
  resolveGrantedPaths,
  type FolderGrant,
  type SessionLike,
} from "../src/paths.ts";

function evt(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data };
}

function session(id: string, events: unknown[] = [], parentSession?: string): SessionLike {
  return { id, events: events as SessionLike["events"], header: parentSession === undefined ? {} : { parentSession } };
}

test("parseGrantToken accepts an absolute path", () => {
  assert.deepEqual(parseGrantToken("/mnt/data"), { grant: { path: "/mnt/data" } });
});

test("parseGrantToken rejects a relative path", () => {
  const result = parseGrantToken("relative/path");
  assert.ok("error" in result);
});

test("parseGrantToken rejects an empty token", () => {
  assert.ok("error" in parseGrantToken(""));
});

test("parseGrantToken rejects root / (cannot bind over the sandbox root)", () => {
  assert.ok("error" in parseGrantToken("/"));
});

test("foldFolderGrants returns empty for no events", () => {
  assert.deepEqual(foldFolderGrants(undefined), []);
  assert.deepEqual(foldFolderGrants([]), []);
});

test("foldFolderGrants ignores non-folder events", () => {
  const events = [
    evt("sandbox/device-root", { op: "add", path: "/dev/ttyUSB0" }),
    evt("something/else", { op: "add", path: "/x" }),
  ];
  assert.deepEqual(foldFolderGrants(events), []);
});

test("foldFolderGrants adds, removes, and clears grants in log order", () => {
  const events = [
    evt("sandbox/folder-root", { op: "add", path: "/a" }),
    evt("sandbox/folder-root", { op: "add", path: "/b" }),
    evt("sandbox/folder-root", { op: "remove", path: "/a" }),
    evt("sandbox/folder-root", { op: "clear" }),
    evt("sandbox/folder-root", { op: "add", path: "/c" }),
  ];
  assert.deepEqual(foldFolderGrants(events), [{ path: "/c" }]);
});

test("foldFolderGrants ignores malformed folder events", () => {
  const events = [
    evt("sandbox/folder-root", { op: "add" }), // no path
    evt("sandbox/folder-root", { op: "add", path: "relative" }), // not absolute
    evt("sandbox/folder-root", { op: "bogus", path: "/x" }), // unknown op
  ];
  assert.deepEqual(foldFolderGrants(events), []);
});

test("grantKey namespaces a grant by its path", () => {
  assert.equal(grantKey({ path: "/x" }), "path:/x");
});

test("collectGrants returns only the session's own grants when there is no parent", () => {
  const s = session("s1", [evt("sandbox/folder-root", { op: "add", path: "/own" })]);
  const sessions = new Map<string, SessionLike>([["s1", s]]);
  assert.deepEqual(collectGrants(sessions, s), [{ path: "/own" }]);
});

test("collectGrants unions grants along the parentSession chain", () => {
  const child = session("child", [evt("sandbox/folder-root", { op: "add", path: "/child" })], "parent");
  const parent = session("parent", [evt("sandbox/folder-root", { op: "add", path: "/parent" })], "grand");
  const grand = session("grand", [evt("sandbox/folder-root", { op: "add", path: "/grand" })]);
  const sessions = new Map<string, SessionLike>([
    ["child", child],
    ["parent", parent],
    ["grand", grand],
  ]);
  const grants = collectGrants(sessions, child);
  assert.deepEqual(grants, [{ path: "/child" }, { path: "/parent" }, { path: "/grand" }]);
});

test("collectGrants is cycle-safe", () => {
  const a = session("a", [evt("sandbox/folder-root", { op: "add", path: "/a" })], "b");
  const b = session("b", [evt("sandbox/folder-root", { op: "add", path: "/b" })], "a");
  const sessions = new Map<string, SessionLike>([
    ["a", a],
    ["b", b],
  ]);
  assert.deepEqual(collectGrants(sessions, a), [{ path: "/a" }, { path: "/b" }]);
});

test("resolveGrantedPaths returns the grant's path as-is (no stat)", () => {
  const grant: FolderGrant = { path: "/does/not/exist" };
  assert.deepEqual(resolveGrantedPaths(grant), ["/does/not/exist"]);
});

test("extraRootsFor deduplicates paths across inherited grants", () => {
  const child = session("child", [evt("sandbox/folder-root", { op: "add", path: "/dup" })], "parent");
  const parent = session("parent", [evt("sandbox/folder-root", { op: "add", path: "/dup" })]);
  const sessions = new Map<string, SessionLike>([
    ["child", child],
    ["parent", parent],
  ]);
  assert.deepEqual(extraRootsFor(sessions, child), ["/dup"]);
});
