#!/usr/bin/env node
// repair-device-root-sessions.mjs
//
// One-off repair: sessions under a given DSH sessions workspace that contain
// `sandbox/device-root` events (written by the flash-device-auth plugin) fail
// to load in an older harness whose KNOWN_SESSION_EVENT_TYPES does not include
// that type and whose writer did not mark the events ignorable.
//
// The events are purely informational (per-session device grants); they carry
// no surface/message semantics and their loss cannot change reconstruction.
// This script rewrites each affected session's compressed log so those events
// carry the envelope's `ignorable: true` marker (a sibling of `type`/`seq`/
// `time`/`data`), which the reader already accepts and then skips.
//
// FRAME PRESERVATION (critical): the JSONL persistence backend stores the log
// as a concatenation of independently decodable, checksummed Zstandard frames
// (header frame first, then one frame per durable append batch). Its reader
// enforces that the first frame decodes to exactly one header line and that
// every later frame decomposes into whole JSONL records. Naively recompressing
// the whole log collapses those boundaries and corrupts the artifact. This
// script therefore re-scans the exact frame layout, decompresses each frame,
// rewrites only the device-root lines inside it, recompresses each frame with
// the same checksum option the harness uses (ZSTD_c_checksumFlag), and
// concatenates the frames in order — byte-identical layout to the original
// except for the inserted `"ignorable":true` marker.
//
// Safety:
//   - every original `session.jsonl.zstd` is backed up as `session.jsonl.zstd.bak`
//     (kept, never overwritten) before any rewrite;
//   - a frame with no device-root lines is recompressed but its decompressed
//     bytes are unchanged, and only frames that actually changed are written
//     back; we still rebuild the whole container so the concat is coherent;
//   - before writing, the script verifies every reconstructed frame decodes
//     back to the expected byte string.
//
// Usage:
//   node scripts/repair-device-root-sessions.mjs [--dry-run] [session-dir ...]
//   (default session-dir: ~/.dsh/sessions/--home-l-wuji_proj-ota-encryption--)

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const sessionDirs = args.length > 0
	? args
	: [join(homedir(), ".dsh", "sessions", "--home-l-wuji_proj-ota-encryption--")];

const EVENT_LINE = '"type":"sandbox/device-root"';
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian

/** The exact option the harness uses to compress each frame (checksummed). */
const CHECKSUM_OPTIONS = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } };

/** A sessions WORKSPACE root: expand it into its session-* subdirectories. */
function expandSessionDirs(dirs) {
	const out = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) { out.push(dir); continue; }
		if (existsSync(join(dir, "session.jsonl.zstd"))) { out.push(dir); continue; }
		let children;
		try { children = readdirSync(dir); } catch { out.push(dir); continue; }
		if (children.length === 0) { out.push(dir); continue; }
		for (const child of children) out.push(join(dir, child));
	}
	return out;
}

/**
 * Reimplementation of the harness's `scanZstdFrames` (see
 * @deepseek-ai/dsh-session-persistence-jsonl). Returns the byte ranges of each
 * complete frame plus the offset of a torn final frame (undefined when clean).
 */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
			throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
		}
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/** Insert `"ignorable":true,` after the opening brace of a device-root JSON line. */
function markIgnorable(line) {
	const idx = line.indexOf("{");
	if (idx === -1) return null;
	const candidate = line.slice(0, idx + 1) + '"ignorable":true,' + line.slice(idx + 1);
	try {
		const parsed = JSON.parse(candidate);
		if (parsed.type === "sandbox/device-root" && parsed.ignorable === true) return candidate;
	} catch {
		// fall through
	}
	return null;
}

/** Rewrite one frame's plaintext, marking device-root lines ignorable. */
function rewriteFramePlaintext(plaintext) {
	const text = plaintext.toString("utf8");
	if (!text.includes(EVENT_LINE)) return { text: null, changed: 0, errors: 0 };
	const lines = text.split("\n");
	let changed = 0;
	let errors = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(EVENT_LINE)) continue;
		const marked = markIgnorable(line);
		if (marked === null) {
			errors += 1;
			console.error(`  ✗ device-root line could not be marked: ${line.slice(0, 120)}`);
			continue;
		}
		lines[i] = marked;
		changed += 1;
	}
	return { text: lines.join("\n"), changed, errors };
}

function processSessionDir(dir) {
	const logPath = join(dir, "session.jsonl.zstd");
	if (!existsSync(logPath)) return { dir, status: "skip", detail: "no session.jsonl.zstd" };
	const original = readFileSync(logPath);
	const { frames, tornStart } = scanZstdFrames(original);
	if (frames.length === 0) return { dir, status: "skip", detail: "no complete zstd frames" };
	if (tornStart !== undefined) {
		return { dir, status: "error", detail: `final frame torn at byte ${tornStart}; refusing to rewrite a torn log` };
	}

	const outputs = [];
	let totalChanged = 0;
	let totalErrors = 0;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i];
		const frameBytes = original.subarray(f.start, f.end);
		const plaintext = zstdDecompressSync(frameBytes);
		const result = rewriteFramePlaintext(plaintext);
		if (result.changed === 0) {
			// unchanged frame — recompress is not even needed; reuse original bytes
			outputs.push(frameBytes);
			continue;
		}
		if (result.errors > 0) {
			totalErrors += result.errors;
			// do not risk rewriting a frame whose line failed to mark; keep original
			outputs.push(frameBytes);
			continue;
		}
		totalChanged += result.changed;
		const recompressed = zstdCompressSync(Buffer.from(result.text, "utf8"), CHECKSUM_OPTIONS);
		// verify round-trip before trusting the recompressed frame
		const verify = zstdDecompressSync(recompressed).toString("utf8");
		if (verify !== result.text) {
			return { dir, status: "error", detail: `frame ${i} round-trip verification failed; aborting` };
		}
		outputs.push(recompressed);
	}

	if (totalChanged === 0) {
		return { dir, status: "skip", detail: totalErrors > 0 ? "device-root lines failed to mark" : "no sandbox/device-root events" };
	}
	if (totalErrors > 0) {
		return { dir, status: "error", detail: `${totalErrors} line(s) failed to mark; aborting write` };
	}

	const newData = Buffer.concat(outputs);
	if (DRY_RUN) {
		return { dir, status: "dry-run", detail: `${totalChanged} device-root event(s) would be marked ignorable across ${frames.length} frame(s)` };
	}

	const bakPath = logPath + ".bak";
	if (!existsSync(bakPath)) copyFileSync(logPath, bakPath);
	writeFileSync(logPath, newData);
	return { dir, status: "repaired", detail: `${totalChanged} device-root event(s) marked ignorable (frames preserved: ${frames.length})`, backup: bakPath };
}

let total = 0;
for (const dir of expandSessionDirs(sessionDirs)) {
	if (!existsSync(dir) || !existsSync(join(dir, "session.jsonl.zstd"))) continue;
	const result = processSessionDir(dir);
	console.log(`${result.status === "repaired" || result.status === "dry-run" ? "•" : " "} ${result.dir} — ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
	if (result.status === "repaired" || result.status === "dry-run") total += 1;
	if (result.status === "error") process.exitCode = 1;
}
console.log("");
console.log(`${DRY_RUN ? "dry run" : "repair"} complete — ${total} session(s) affected.`);
if (!DRY_RUN) console.log("REMINDER: reload the session list in the web UI; the running process may need a restart if it cached the failure.");
