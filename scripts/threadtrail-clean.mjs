#!/usr/bin/env node
/**
 * ThreadTrail maintenance CLI.
 *
 *   node scripts/threadtrail-clean.mjs status          list op logs (size, lines, bloat flags)
 *   node scripts/threadtrail-clean.mjs clean <session> truncate one session's op log (like the panel clean)
 *   node scripts/threadtrail-clean.mjs gc [--dry-run]  drop blobs/diffs no longer referenced by any op log
 *
 * Uses the built `threadtrail-server` dist for `clean` so it behaves exactly
 * like the runtime resetOps (truncates the jsonl and rewrites the head record).
 * Run `npm run build` in ThreadTrail/threadtrail-server first.
 *
 * Order matters: `clean` the bloated legacy logs BEFORE `gc`, otherwise gc
 * sees their (unparseable, huge-line) records as garbage and deletes blobs
 * those logs still reference.
 */
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CaptureStore } from '../ThreadTrail/threadtrail-server/dist/capture.js';

const [action, arg] = process.argv.slice(2);

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
/** Overridable for testing against a scratch root. */
const root = process.env.THREADTRAIL_ROOT || path.join(dshHome, 'threadtrail');
const sessionsDir = path.join(root, 'sessions');
const blobsDir = path.join(root, 'blobs');
const diffsDir = path.join(root, 'diffs');

/** Lines above this are never materialized (mirrors capture.ts). */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** Logs larger than this are flagged as needing a clean. */
const BLOAT_BYTES = 64 * 1024 * 1024;

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Stream a file's lines; yields null for oversized lines (never materialized). */
async function* iterLines(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return;
  }
  if (st.size === 0) return;
  const rs = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let discarding = false;
  try {
    for await (const chunk of rs) {
      if (discarding) {
        const idx = chunk.indexOf('\n');
        if (idx < 0) continue;
        yield null;
        buf = chunk.slice(idx + 1);
        discarding = false;
      } else {
        buf += chunk;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > MAX_LINE_CHARS) {
          yield null;
          continue;
        }
        yield line;
      }
      if (!discarding && buf.length > MAX_LINE_CHARS) {
        discarding = true;
        buf = '';
      }
    }
    if (!discarding && buf.length) yield buf;
  } finally {
    rs.destroy();
  }
}

async function status() {
  const files = (await fs.readdir(sessionsDir))
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  console.log(`op-log root: ${sessionsDir}\n`);
  let total = 0;
  for (const f of files) {
    const st = await fs.stat(path.join(sessionsDir, f));
    total += st.size;
    let lines = 0;
    let skipped = 0;
    for await (const line of iterLines(path.join(sessionsDir, f))) {
      if (line === null) skipped++;
      else lines++;
    }
    const flag = st.size > BLOAT_BYTES || skipped > 0 ? '  <-- consider clean' : '';
    console.log(
      `${f.replace(/\.jsonl$/, '')}\t${human(st.size)}\tlines=${lines}\tgiantLines=${skipped}${flag}`,
    );
  }
  console.log(`\ntotal: ${human(total)}`);
}

async function clean(sessionId) {
  if (!SESSION_RE.test(sessionId)) {
    console.error(`invalid session id: ${sessionId}`);
    process.exit(2);
  }
  const store = new CaptureStore({ root });
  await store.init();
  const sc = store.getOrCreate(sessionId, null);
  const before = await sc.jsonlBytes();
  await sc.resetOps({ trigger: 'manual' });
  console.log(`cleaned ${sessionId}: ${human(before)} -> 0 bytes (head bookkeeping kept)`);
}

async function gc() {
  const dryRun = arg === '--dry-run';
  const jls = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl'));
  const referenced = new Set();
  let unparsed = 0;
  for (const f of jls) {
    for await (const line of iterLines(path.join(sessionsDir, f))) {
      if (line === null) {
        unparsed++;
        continue;
      }
      try {
        const rec = JSON.parse(line);
        for (const fc of rec.files ?? []) {
          if (fc.sha) referenced.add(fc.sha);
          if (fc.prevSha) referenced.add(fc.prevSha);
          if (fc.diffSha) referenced.add(fc.diffSha);
        }
      } catch {
        unparsed++;
      }
    }
  }
  if (unparsed > 0) {
    console.warn(
      `note: ${unparsed} oversized/unparseable line(s) were not scanned; their blob references count as garbage. ` +
        'Clean those sessions first if you still need their history.',
    );
  }
  for (const dir of [blobsDir, diffsDir]) {
    let freed = 0;
    let bytes = 0;
    for (const f of await fs.readdir(dir)) {
      if (referenced.has(f)) continue;
      let size = 0;
      try {
        size = (await fs.stat(path.join(dir, f))).size;
      } catch {
        continue;
      }
      bytes += size;
      freed++;
      if (!dryRun) {
        try {
          await fs.rm(path.join(dir, f));
        } catch {
          /* keep going */
        }
      }
    }
    console.log(`${dryRun ? 'would free' : 'freed'} ${freed} file(s) (${human(bytes)}) in ${path.basename(dir)}`);
  }
  if (dryRun) console.log('(dry run — nothing deleted)');
}

switch (action) {
  case 'status':
    await status();
    break;
  case 'clean':
    await clean(arg);
    break;
  case 'gc':
    await gc();
    break;
  default:
    console.log(
      'usage: node scripts/threadtrail-clean.mjs {status|clean <sessionId>|gc [--dry-run]}',
    );
    process.exit(1);
}
