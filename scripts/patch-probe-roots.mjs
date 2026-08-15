#!/usr/bin/env node
// patch-probe-roots.mjs
//
// Idempotent patch for DSH's sandbox packages that enables per-session
// "extra writable roots" — the enforcement hook behind the flash-device-auth
// plugin (per-session debug-probe authorization).
//
// Patches (all additive; absent `extraWritableRoots` keeps today's behavior):
//   1. @deepseek-ai/dsh-sandbox        writableRoots()      → seatbelt + fs fence
//   2. @deepseek-ai/dsh-sandbox-local  bwrapProfileArgs()   → bind probe nodes into the bwrap container
//   3. @deepseek-ai/dsh-sandbox-local  landlockProfileArgs() → Landlock write grants for probe nodes
//
// Usage:
//   node scripts/patch-probe-roots.mjs          # apply (idempotent)
//   node scripts/patch-probe-roots.mjs --revert # revert to pristine
//
// After applying, restart `dsh web` (the running process already loaded the
// unpatched modules). Re-run after any DSH upgrade — the script locates the
// installed tree and refuses to patch text that no longer matches, so you
// notice when upstream changed and the patch needs updating.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "extraWritableRoots";

// ── exact original → patched pairs (tabs are significant) ──────────────────

const PATCHES = [
	{
		file: "dsh-sandbox/lib/index.js",
		original: `function writableRoots(policy) {
\tif (policy.mode !== "workspace-write") return [];
\treturn [...new Set([
\t\tpolicy.workspaceRoot,
\t\t"/tmp",
\t\ttmpdir()
\t].map(canonicalPath))];
}`,
		patched: `function writableRoots(policy) {
\tif (policy.mode !== "workspace-write") return [];
\treturn [...new Set([
\t\tpolicy.workspaceRoot,
\t\t"/tmp",
\t\ttmpdir(),
\t\t...(Array.isArray(policy.extraWritableRoots) ? policy.extraWritableRoots : [])
\t].map(canonicalPath))];
}`,
		verify: (source) => source.includes("policy.extraWritableRoots) ? policy.extraWritableRoots : []")
	},
	{
		file: "dsh-sandbox-local/lib/index.js",
		original: `\tif (policy.mode === "workspace-write") {
\t\targs.push("--tmpfs", "/tmp");
\t\targs.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
\t}
\treturn args;`,
		// --dev-bind (not --bind): bind-mounted device nodes are only openable
		// inside the bwrap user namespace when mounted with --dev-bind; it also
		// creates missing parent directories, so no --dir loop is needed.
		patched: `\tif (policy.mode === "workspace-write") {
\t\targs.push("--tmpfs", "/tmp");
\t\targs.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
\t\tfor (const root of policy.extraWritableRoots ?? []) args.push("--dev-bind", root, root);
\t}
\treturn args;`,
		verify: (source) => source.includes("args.push(\"--dev-bind\", root, root)"),
		// v1 of the patch used --dir + --bind; upgrade trees that carry it.
		legacyPatched: `\tif (policy.mode === "workspace-write") {
\t\targs.push("--tmpfs", "/tmp");
\t\targs.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
\t\tfor (const root of policy.extraWritableRoots ?? []) {
\t\t\tconst segments = root.split("/").filter(Boolean);
\t\t\tlet current = "";
\t\t\tfor (const segment of segments.slice(0, -1)) {
\t\t\t\tcurrent += "/" + segment;
\t\t\t\targs.push("--dir", current);
\t\t\t}
\t\t\targs.push("--bind", root, root);
\t\t}
\t}
\treturn args;`
	},
	{
		file: "dsh-sandbox-local/lib/index.js",
		original: `function landlockProfileArgs(policy) {
\tconst readWrite = ["/dev/null"];
\tif (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);
\treturn grantArgs({`,
		patched: `function landlockProfileArgs(policy) {
\tconst readWrite = ["/dev/null"];
\tif (policy.mode === "workspace-write") {
\t\treadWrite.push("/tmp", policy.workspaceRoot);
\t\tfor (const root of policy.extraWritableRoots ?? []) readWrite.push(root);
\t}
\treturn grantArgs({`,
		verify: (source) => source.includes("for (const root of policy.extraWritableRoots ?? []) readWrite.push(root)")
	}
];

/** Locate installed @deepseek-ai package trees that may host the runtime. */
function findPackageFiles() {
	const roots = new Set();
	const npxRoot = join(homedir(), ".npm", "_npx");
	if (existsSync(npxRoot)) {
		for (const entry of readdirSync(npxRoot)) {
			const dir = join(npxRoot, entry, "node_modules", "@deepseek-ai");
			if (existsSync(dir)) roots.add(dir);
		}
	}
	const profiles = join(homedir(), ".dsh", "profiles");
	if (existsSync(profiles)) {
		for (const profile of readdirSync(profiles)) {
			const dir = join(profiles, profile, "node_modules", "@deepseek-ai");
			if (existsSync(dir)) roots.add(dir);
		}
	}
	// explicit --root <dir> args: a node_modules dir, or an @deepseek-ai dir directly
	for (const arg of process.argv) {
		if (arg === "--root" || arg === "--revert") continue;
		if (arg.endsWith("@deepseek-ai") && existsSync(arg)) roots.add(arg);
		else if (existsSync(join(arg, "@deepseek-ai"))) roots.add(join(arg, "@deepseek-ai"));
	}
	const files = new Set();
	for (const root of roots) {
		for (const patch of PATCHES) {
			const path = join(root, patch.file);
			if (existsSync(path)) files.add(path);
		}
	}
	return [...files];
}

function applyToFile(path, patch, revert) {
	const source = readFileSync(path, "utf8");
	const target = revert ? patch.patched : patch.original;
	const replacement = revert ? patch.original : patch.patched;
	const markerHit = patch.verify(source);
	const hasLegacy = patch.legacyPatched !== undefined && source.includes(patch.legacyPatched);
	if (revert) {
		if (hasLegacy) {
			writeFileSync(path, source.replace(patch.legacyPatched, patch.original));
			return { status: "reverted", detail: "legacy patch" };
		}
		if (!markerHit) return { status: "skip", detail: "not patched" };
		if (!source.includes(target)) throw new Error(`${path}: patched text no longer matches — patch has drifted, inspect manually`);
		writeFileSync(path, source.replace(target, replacement));
		return { status: "reverted" };
	}
	if (markerHit) return { status: "skip", detail: "already patched" };
	if (hasLegacy) {
		// upgrade: strip the legacy patched form, then apply the current one
		writeFileSync(path, source.replace(patch.legacyPatched, patch.original));
		const upgraded = readFileSync(path, "utf8");
		if (!upgraded.includes(patch.original)) throw new Error(`${path}: legacy patch could not be reverted cleanly`);
		writeFileSync(path, upgraded.replace(patch.original, patch.patched));
		return { status: "upgraded" };
	}
	if (!source.includes(target)) {
		throw new Error(`${path}: expected original text not found — DSH was upgraded or the patch drifted; update this script's "original" blocks`);
	}
	writeFileSync(path, source.replace(target, replacement));
	return { status: "patched" };
}

/** Runtime self-test against the patched module (skip when module unloadable). */
async function selfTest(root) {
	const indexPath = join(root, "dsh-sandbox/lib/index.js");
	if (!existsSync(indexPath)) return null;
	try {
		const mod = await import(`${pathToFileURL(indexPath).href}?selftest=${Date.now()}`);
		const policy = { mode: "workspace-write", workspaceRoot: "/tmp", extraWritableRoots: ["/dev/null"] };
		const roots = mod.writableRoots(policy);
		return roots.includes("/dev/null") ? { ok: true } : { ok: false, detail: `writableRoots returned ${JSON.stringify(roots)}` };
	} catch (error) {
		// dependency-resolution failures mean this root is a bare fixture, not a live tree — skip
		if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
		return { ok: false, detail: String(error?.message ?? error) };
	}
}

const revert = process.argv.includes("--revert");
const files = findPackageFiles();
if (files.length === 0) {
	console.error("no installed @deepseek-ai sandbox packages found under ~/.npm/_npx or ~/.dsh/profiles");
	process.exit(1);
}

let changed = 0;
for (const path of files) {
	for (const patch of PATCHES) {
		if (!path.endsWith(patch.file)) continue;
		try {
			const result = applyToFile(path, patch, revert);
			console.log(`${result.status === "patched" || result.status === "reverted" || result.status === "upgraded" ? "•" : " "} ${path} — ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
			if (result.status !== "skip") changed += 1;
		} catch (error) {
			console.error(`✗ ${path}: ${error.message}`);
			process.exitCode = 1;
		}
	}
}

// self-test against every located sandbox root
const roots = new Set(files.map((path) => path.slice(0, path.lastIndexOf("node_modules") + "node_modules".length)));
for (const root of roots) {
	const result = await selfTest(root);
	if (result === null) continue;
	if (result.ok) console.log(`✓ self-test ${root} — writableRoots honors extraWritableRoots`);
	else {
		console.error(`✗ self-test ${root} — ${result.detail}`);
		process.exitCode = 1;
	}
}

console.log("");
if (revert) console.log("revert complete" + (changed === 0 ? " (nothing to revert)" : ""));
else {
	console.log(`patch complete (${changed} file(s) touched)`);
	console.log("REMINDER: restart `dsh web` for the running process to load the patched modules.");
}
