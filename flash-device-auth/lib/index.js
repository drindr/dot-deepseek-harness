// flash-device-auth — lib/index.js
//
// Per-session device authorization for the workspace-write sandbox.
//
// The problem it solves (probe-rs / serial flashing on bwrap): the sandbox
// container's /dev is a sparse devtmpfs without udev-populated trees, so
// debug probes and serial devices (/dev/bus/usb/*, /dev/hidraw*, /dev/ttyACM*,
// /dev/ttyUSB*) are invisible inside it and flashing fails unless the call
// escalates to danger-full-access (one approval prompt per flash). This
// plugin lets a session authorize specific devices once; the patched sandbox
// (see scripts/patch-probe-roots.mjs) then binds the authorized nodes into
// the container, so flashing works under workspace-write with no prompts.
//
// Semantics:
//   - Authorization is SESSION-scoped: `sandbox/device-root` events live in
//     the session's durable log; a new session starts with none.
//   - Subagents INHERIT along the parentSession chain (union of grants).
//   - A grant is either a probe spec `vid:pid[:serial]` (re-resolved through
//     sysfs to usbfs + hidraw + ttyACM/ttyUSB nodes at every call, so
//     replug/renumbering are followed automatically) or an exact device path
//     `/dev/...` (covers on-board serial and block targets).
//   - Revocation: `/flashdev remove|clear`, or the session ending.
//   - Anything not authorized behaves exactly as before (deny → human flow).

import { foldDeviceGrants, grantKey, resolveGrantedNodes, scanAttachedUsb } from "./devices.js";

export const name = "flash-device-auth";
const inject = ["sandboxPolicy", "sessions"];

export { inject };

const WRAPPED = Symbol("flash-device-auth:resolve-wrapped");

/** The catalog is a KNOWN-DEVICES registry only — grants are always per-session. */
const DEFAULT_CATALOG = [];

// ── config ──────────────────────────────────────────────────────────────────

function normalizeCatalog(config) {
	const raw = Array.isArray(config?.catalog) ? config.catalog : DEFAULT_CATALOG;
	const catalog = [];
	for (const entry of raw) {
		if (typeof entry?.vid !== "string" || typeof entry?.pid !== "string") continue;
		if (!/^[0-9a-fA-F]{1,4}$/.test(entry.vid) || !/^[0-9a-fA-F]{1,4}$/.test(entry.pid)) continue;
		catalog.push({
			label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : `${entry.vid}:${entry.pid}`,
			vid: entry.vid,
			pid: entry.pid,
			serial: typeof entry.serial === "string" && entry.serial.length > 0 ? entry.serial : undefined
		});
	}
	return catalog;
}

// ── grants: session events + ancestor chain ─────────────────────────────────

/** Union of grants along the parentSession chain (own session included). */
export function collectGrants(sessions, session) {
	const grants = [];
	const seen = new Set();
	let current = session;
	while (current !== undefined && current !== null && !seen.has(current.id)) {
		seen.add(current.id);
		grants.push(...foldDeviceGrants(current.events));
		const parentId = current.header?.parentSession;
		current = parentId === undefined ? undefined : sessions.get(parentId);
	}
	return grants;
}

/** Resolved, deduplicated, currently-present device nodes for a session. */
function extraRootsFor(sessions, session, resolveNodes = resolveGrantedNodes) {
	const grants = new Map();
	for (const grant of collectGrants(sessions, session)) {
		grants.set(grantKey(grant), grant);
	}
	const nodes = [];
	for (const grant of grants.values()) nodes.push(...resolveNodes(grant));
	return [...new Set(nodes)];
}

// ── resolve wrap ────────────────────────────────────────────────────────────

/**
 * Build the wrapped `resolve` for the sandbox-policy service. Pure and
 * dependency-injected for testing.
 * @param options - { resolve, sessions, resolveNodes? }
 * @returns the wrapper function.
 */
export function makeResolveWrapper({ resolve, sessions, resolveNodes = resolveGrantedNodes }) {
	return function (request = {}) {
		const policy = resolve(request);
		const session = request.session;
		// extra roots only have meaning under workspace-write confinement
		if (session === undefined || policy.mode !== "workspace-write") return policy;
		const extra = extraRootsFor(sessions, session, resolveNodes);
		if (extra.length === 0) return policy;
		return { ...policy, extraWritableRoots: [...(policy.extraWritableRoots ?? []), ...extra] };
	};
}

function wrapResolve(ctx) {
	const service = ctx.sandboxPolicy;
	if (service === undefined || service[WRAPPED]) return;
	service[WRAPPED] = true;
	const original = service.resolve;
	service.resolve = makeResolveWrapper({
		resolve: (request) => original.call(service, request),
		sessions: ctx.sessions
	});
	// HMR-safe: on plugin reload, restore the pristine resolve and clear the
	// flag so the fresh plugin instance re-wraps with its own (current) code.
	ctx.effect(() => () => {
		service.resolve = original;
		service[WRAPPED] = false;
	});
}

// ── /flashdev command ───────────────────────────────────────────────────────

/**
 * Parse one grant token: `all` (every catalog entry), a catalog label,
 * `vid:pid[:serial]`, or an absolute device path (`/dev/...`).
 */
function parseGrantToken(token, catalog) {
	if (token === "all") return { all: true };
	if (token.startsWith("/dev/")) {
		return { grant: { path: token } };
	}
	const labeled = catalog.find((entry) => entry.label === token);
	if (labeled !== undefined) return { grant: labeled };
	const m = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})(?::(.+))?$/.exec(token);
	if (m !== null) {
		return {
			grant: {
				vid: m[1],
				pid: m[2],
				serial: m[3] !== undefined && m[3].length > 0 ? m[3] : undefined
			}
		};
	}
	return { error: `unknown device "${token}" (use a catalog label, vid:pid[:serial], a /dev path, or all)` };
}

function describeGrant(grant) {
	return grant.path !== undefined ? grant.path : `${grant.vid}:${grant.pid}${grant.serial === undefined ? "" : ":" + grant.serial}`;
}

/**
 * Build the lossless-JSON event payload for one grant. The session log
 * REJECTS `undefined` values (stricter than JSON.stringify, which would
 * silently drop them), so absent serial/path keys are omitted entirely.
 */
export function grantEventData(op, grant) {
	if (grant.path !== undefined) return { op, path: grant.path };
	const data = { op, vid: grant.vid, pid: grant.pid };
	if (grant.serial !== undefined) data.serial = grant.serial;
	return data;
}

/**
 * Resolve the `all` grant set: the catalog when non-empty, otherwise every
 * currently-attached USB device (so `/flashdev add all` always does something
 * useful even with an empty catalog). Pure and testable.
 */
export function expandAll(catalog, attached) {
	if (catalog.length > 0) {
		return { grants: catalog.map(({ vid, pid, serial }) => ({ vid, pid, serial })), source: "catalog" };
	}
	return { grants: (attached ?? []).map(({ vid, pid, serial }) => ({ vid, pid, serial })), source: "attached USB devices" };
}

function registerCommands(ctx, catalog) {
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "flashdev",
			description: "Authorize devices for THIS session (flash-device-auth)",
			input: { hint: "add|remove|list|scan|clear [label|vid:pid[:serial]|/dev/path|all]" },
			handler: ({ agent, rawInput }) => {
				const session = agent.session;
				const [op, ...rest] = rawInput.trim().split(/\s+/);
				const token = rest.join(" ");
				const result = (kind, text) => ({ kind, text });

				if (op === "list") {
					const grants = collectGrants(ctx.sessions, session);
					const nodes = extraRootsFor(ctx.sessions, session);
					const lines = [
						`catalog: ${catalog.map((entry) => `${entry.label} (${describeGrant(entry)})`).join(", ") || "(none — configure catalog or grant by vid:pid/path)"}`,
						`authorized this session: ${grants.map(describeGrant).join(", ") || "(none)"}`,
						`resolved nodes: ${nodes.join(", ") || "(none — device unplugged?)"}`
					];
					return result("success", lines.join("\n"));
				}
				if (op === "scan") {
					const grants = collectGrants(ctx.sessions, session);
					const granted = new Set(grants.map((g) => (g.path !== undefined ? `path:${g.path}` : `${g.vid.toLowerCase()}:${g.pid.toLowerCase()}`)));
					const attached = scanAttachedUsb();
					if (attached.length === 0) return result("success", "no USB devices found (sysfs unavailable?)");
					const lines = attached.map((dev) => {
						const key = `${dev.vid.toLowerCase()}:${dev.pid.toLowerCase()}`;
						const marked = granted.has(key) || granted.has(`path:${key}`) ? " [authorized]" : "";
						return `${dev.vid}:${dev.pid}${dev.serial === undefined ? "" : ":" + dev.serial}${marked}`;
					});
					return result("success", ["attached USB devices:", ...lines].join("\n"));
				}
				if (op === "clear") {
					session.append("sandbox/device-root", { op: "clear" });
					return result("success", "all flash-device grants cleared for this session");
				}
				if (op !== "add" && op !== "remove") {
					return result("error", 'usage: /flashdev add|remove|list|scan|clear [label|vid:pid[:serial]|/dev/path|all]');
				}
				if (token === "") return result("error", "missing device (use a catalog label, vid:pid[:serial], a /dev path, or all)");
				if (op === "remove" && token === "all") {
					// "remove all" = revoke every grant for this session
					session.append("sandbox/device-root", { op: "clear" });
					return result("success", "revoked ALL flash-device grants for this session");
				}
				const parsed = parseGrantToken(token, catalog);
				if (parsed.error !== undefined) return result("error", parsed.error);
				let grants;
				let via;
				if (parsed.all) {
					const expanded = expandAll(catalog, scanAttachedUsb());
					grants = expanded.grants;
					via = expanded.source;
				} else {
					grants = [parsed.grant];
					via = null;
				}
				if (grants.length === 0) {
					return result("error", "nothing to add: catalog is empty and no USB devices are currently attached (plug in the device, or grant by vid:pid[:serial] / /dev path)");
				}
				for (const grant of grants) {
					// the session log rejects undefined values (lossless JSON),
					// so absent serial/path keys must be OMITTED, not undefined
					session.append("sandbox/device-root", grantEventData(op, grant));
				}
				const names = grants.map(describeGrant).join(", ");
				return result("success", op === "add"
					? `authorized for this session${via === null ? "" : ` (via ${via})`}: ${names}`
					: `revoked for this session: ${names}`);
			}
		});
	});
}

// ── system-prompt context ───────────────────────────────────────────────────

function injectPromptContext(ctx, catalog) {
	ctx.inject(["systemPrompt"], (scope) => {
		scope.systemPrompt.context({
			name: "flash-device-auth:policy",
			order: 116,
			text: (context) => {
				const agent = context.agent;
				if (agent === undefined) return "";
				const grants = collectGrants(ctx.sessions, agent.session);
				if (grants.length === 0) {
					const labels = catalog.length > 0 ? ` (labels: ${catalog.map((entry) => entry.label).join(", ")})` : "";
					return `Device access: NONE authorized for this session. If a flashing command fails because a probe/serial device is inaccessible, ask the USER to run \`/flashdev add <vid:pid[:serial]>\`, \`/flashdev add <device path>\` (e.g. /dev/ttyUSB0), or \`/flashdev add all\`${labels} to authorize devices for THIS session only. \`/flashdev scan\` lists attached USB devices.`;
				}
				return `Device access: authorized for this session: ${grants.map(describeGrant).join(", ")}. Writes to these devices' nodes are allowed under workspace-write; do not escalate for them.`;
			}
		});
	});
}

// ── plugin ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
	const catalog = normalizeCatalog(config);
	wrapResolve(ctx);
	registerCommands(ctx, catalog);
	injectPromptContext(ctx, catalog);
}
