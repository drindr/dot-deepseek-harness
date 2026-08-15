// chunk-trim — dsh web host plugin.
//
// Why: the GUI opens a session with one `session.history {maxMessages: 50}`
// call, but the server pages the whole raw event window between the oldest
// page message and the tail. Reasoning-capable models stream token-sized
// `assistant/chunk` events (reasoning-delta / text-delta / tool-call-delta),
// so one 50-message page can carry 15k–41k events / 3.5–7.8 MB of JSON, ~94%
// of it token-delta chunks. The client then has to download, parse and fold
// all of them on every open and every "load older" page.
//
// This plugin wraps the host's `ctx.apiProxy.sessions.history` and
// `ctx.apiProxy.subagents.history` (both are plain methods on the public
// apiProxy service; the RPC dispatcher looks the method up at invoke time, so
// the wrapper is picked up by every transport) and drops the token-delta
// chunk events from each response page — except the first and last event of
// the page, which are kept so `loadOlder`'s tail-seq + 1 === baseSeq
// contiguity check keeps passing across page boundaries.
//
// What survives: user/assistant messages, tool call/result, step/turn
// boundaries, and the sparse non-delta chunk events (usage/finish — one or
// two per step). block-start/block-end chunks are dropped too: a block-end
// carries the full final block text that the assistant/message content
// already contains (a measured ~147 KB per 50-message page of pure
// duplication), and the conversation view renders from assistant/message
// only.
//
// No client half, no runtime dependencies: pure ESM, `main` points straight
// at this file.

/** Chunk kinds dropped from history pages (redundant or token-level). */
const DROPPED_CHUNK_TYPES = new Set([
	"reasoning-delta",
	"text-delta",
	"tool-call-delta",
	"block-start",
	"block-end"
]);

/** True for the chunk events history pages can serve without (delta flood + boundary markers duplicated by assistant/message). */
function isDroppedChunk(event) {
	if (event.type !== "assistant/chunk") return false;
	const chunk = event.data?.chunk;
	return chunk !== void 0 && chunk !== null && DROPPED_CHUNK_TYPES.has(chunk.type);
}

/**
 * Drop interior dropped-chunk events from one history page.
 * `entries` items are `{ event, view? }`. The first and last entries are
 * always kept (pagination contiguity across `loadOlder`); a page of fewer
 * than three events is returned untouched.
 */
function trimChunkFlood(entries) {
	if (entries.length < 3) return entries;
	const out = [];
	const last = entries.length - 1;
	for (let i = 0; i <= last; i++) {
		if (i === 0 || i === last || !isDroppedChunk(entries[i].event)) out.push(entries[i]);
	}
	return out;
}

/** Stable Cordis plugin name (also the loader insert id). */
const name = "chunk-trim";

/** Defer mounting until the apiProxy service exists. */
const inject = ["apiProxy"];

function apply(ctx) {
	const api = ctx.apiProxy;
	const originals = {
		sessionsHistory: api.sessions.history,
		subagentsHistory: api.subagents.history
	};
	const makeWrapper = (originalMethod) => function (request, ...rest) {
		const result = originalMethod.call(this, request, ...rest);
		const filter = (response) => {
			const value = response?.result?.ok === true ? response.result.value : void 0;
			if (value !== void 0 && Array.isArray(value.events)) value.events = trimChunkFlood(value.events);
			return response;
		};
		return result !== void 0 && typeof result.then === "function" ? result.then(filter) : filter(result);
	};
	api.sessions.history = makeWrapper(originals.sessionsHistory);
	api.subagents.history = makeWrapper(originals.subagentsHistory);
	ctx.effect(() => () => {
		api.sessions.history = originals.sessionsHistory;
		api.subagents.history = originals.subagentsHistory;
	}, "chunk-trim: restore apiProxy history methods");
}

export { apply, inject, name, trimChunkFlood };
