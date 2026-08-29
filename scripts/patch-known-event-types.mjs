#!/usr/bin/env node
// patch-known-event-types.mjs
//
// Idempotent patch for @deepseek-ai/dsh-session: register the custom
// `sandbox/device-root` event type (written by the flash-device-auth plugin,
// which ships in this workspace) into the persistence reader's
// KNOWN_SESSION_EVENT_TYPES set.
//
// Why: the harness's session persistence REFUSES to read a log whose event
// vocabulary includes a type outside its known set AND that is not marked
// `ignorable` on the envelope. The flash-device-auth plugin appends
// `sandbox/device-root` events (per-session device grants) that are purely
// informational — they carry no surface/message semantics — but the current
// `Session.append()` API gives plugins no way to stamp the `ignorable` marker,
// and the stock harness does not know the type. The result is
// "history unavailable ... SessionFormatUnsupportedError" for any session that
// ever ran `/flashdev add ...`.
//
// This patch registers the type so both LOADING (future sessions) and future
// WRITES round-trip through this harness. Existing already-written logs are a
// separate one-off concern, handled by repair-device-root-sessions.mjs.
//
// Patches two artifacts (the bundled `lib/index.js` keeps its own inlined copy
// of the catalog, and `lib/types/known-event-types.js` is the source module):
//   - the inlined Set literal in dsh-session/lib/index.js
//   - the Set literal in dsh-session/lib/types/known-event-types.js
//
// Usage:
//   node scripts/patch-known-event-types.mjs           # apply (idempotent)
//   node scripts/patch-known-event-types.mjs --revert  # revert to pristine
//
// After applying, restart `dsh web` and re-run after any DSH upgrade (same as
// patch-probe-roots.mjs — it refuses to patch drifted text).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EVENT_TYPE = "sandbox/device-root";

// ── exact original → patched pairs ─────────────────────────────────────────

// Two syntactic forms coexist: the bundled lib/index.js normally uses tabs +
// double quotes; the source known-event-types.js uses 4-space + single quotes.
// Each patch entry targets its file and its exact literal.
const PATCHES = [
	{
		file: "dsh-session/lib/types/known-event-types.js",
		// 4-space indent, single quotes (source module)
		original: `    'sandbox/mode',`,
		patched: `    'sandbox/device-root',
    'sandbox/mode',`,
		verify: (source) => source.includes(`'sandbox/device-root',`)
	},
	{
		file: "dsh-session/lib/index.js",
		// tab indent, double quotes (bundled inlined copy)
		original: `\t"sandbox/mode",`,
		patched: `\t"sandbox/device-root",
\t"sandbox/mode",`,
		verify: (source) => source.includes(`"sandbox/device-root",`)
	}
];

/** Locate installed @deepseek-ai trees that may host dsh-session. */
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
	const markerHit = patch.verify(source);
	if (revert) {
		if (!markerHit) return { status: "skip", detail: "not patched" };
		if (!source.includes(patch.patched)) throw new Error(`${path}: patched text no longer matches — patch has drifted, inspect manually`);
		writeFileSync(path, source.replace(patch.patched, patch.original));
		// leave an empty trailing entry's stray line cleanly removed above
		return { status: "reverted" };
	}
	if (markerHit) return { status: "skip", detail: "already patched" };
	if (!source.includes(patch.original)) {
		throw new Error(`${path}: expected original text not found — DSH was upgraded or the patch drifted; update this script's "original" blocks`);
	}
	writeFileSync(path, source.replace(patch.original, patch.patched));
	return { status: "patched" };
}

const revert = process.argv.includes("--revert");
const files = findPackageFiles();
if (files.length === 0) {
	console.error("no installed @deepseek-ai dsh-session packages found under ~/.npm/_npx or ~/.dsh/profiles");
	process.exit(1);
}

let changed = 0;
for (const path of files) {
	for (const patch of PATCHES) {
		if (!path.endsWith(patch.file)) continue;
		try {
			const result = applyToFile(path, patch, revert);
			console.log(`${result.status === "patched" || result.status === "reverted" ? "•" : " "} ${path} — ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
			if (result.status !== "skip") changed += 1;
		} catch (error) {
			console.error(`✗ ${path}: ${error.message}`);
			process.exitCode = 1;
		}
	}
}

console.log("");
if (revert) console.log("revert complete" + (changed === 0 ? " (nothing to revert)" : ""));
else {
	console.log(`patch complete (${changed} file(s) touched) — ${EVENT_TYPE} registered as a known session event type.`);
	console.log("REMINDER: restart `dsh web` for the running process to load the patched module.");
}
