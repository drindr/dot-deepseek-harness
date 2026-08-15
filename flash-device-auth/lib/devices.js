// flash-device-auth — lib/devices.js
//
// General device-authorization logic. A session grant is either:
//   - a probe spec { vid, pid, serial? } — resolved through sysfs to every
//     device node that identity currently maps to (usbfs + hidraw + ttyACM /
//     ttyUSB), so replug and renumbering are followed automatically; or
//   - an exact device path { path } — a /dev node the user named directly
//     (covers on-board serial like /dev/ttyS0, block targets, anything that
//     has no USB identity to resolve).
// The fold reads `sandbox/device-root` events from the session log; all
// sysfs access is relative to a `base` (default "/sys") so tests can run
// against fixture trees.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const HEX = /^[0-9a-fA-F]{1,4}$/;
const HIDRAW_TTY_CLASSES = new Set(["hidraw", "tty"]);
const TTY_PREFIXES = ["ttyACM", "ttyUSB"];

/** Stable identity key for one probe spec: `vid:pid` or `vid:pid:serial`. */
export function specKey(vid, pid, serial) {
	const v = String(vid).toLowerCase();
	const p = String(pid).toLowerCase();
	return serial === undefined ? `${v}:${p}` : `${v}:${p}:${serial}`;
}

/** Grant key namespace: `spec:...` for probe specs, `path:...` for paths. */
export function grantKey(grant) {
	if (grant.path !== undefined) return `path:${grant.path}`;
	return `spec:${specKey(grant.vid, grant.pid, grant.serial)}`;
}

function isUsbSpec(data) {
	return typeof data.vid === "string" && typeof data.pid === "string" && HEX.test(data.vid) && HEX.test(data.pid);
}

/**
 * Fold `sandbox/device-root` events (log order) into the current grants.
 * Grant events: `{op:"add"|"remove", vid, pid, serial?}` (probe specs) or
 * `{op:"add"|"remove", path}` (exact device paths); `{op:"clear"}` empties.
 * Returns the current grant list (mixed specs and paths).
 */
export function foldDeviceGrants(events) {
	const state = new Map();
	for (const event of events ?? []) {
		if (event?.type !== "sandbox/device-root") continue;
		const data = event.data ?? {};
		if (data.op === "clear") {
			state.clear();
			continue;
		}
		if (data.path !== undefined) {
			if (typeof data.path !== "string") continue;
			if (!data.path.startsWith("/dev/") || data.path.length <= "/dev/".length) continue;
			// no path traversal: a grant must stay inside /dev
			if (data.path.includes("/../") || data.path.endsWith("/..")) continue;
			const grant = { path: data.path };
			const key = grantKey(grant);
			if (data.op === "add") state.set(key, grant);
			else if (data.op === "remove") state.delete(key);
			continue;
		}
		if (!isUsbSpec(data)) continue;
		const serial = typeof data.serial === "string" && data.serial.length > 0 ? data.serial : undefined;
		const grant = { vid: data.vid, pid: data.pid, serial };
		const key = grantKey(grant);
		if (data.op === "add") state.set(key, grant);
		else if (data.op === "remove") state.delete(key);
	}
	return [...state.values()];
}

function readSys(base, rel) {
	try {
		return readFileSync(join(base, rel), "utf8").trim();
	} catch {
		return undefined;
	}
}

/** Does this sysfs USB entry (e.g. "bus/usb/devices/3-1") match the spec? */
export function usbEntryMatches(base, entryRel, spec) {
	const vid = readSys(base, join(entryRel, "idVendor"));
	const pid = readSys(base, join(entryRel, "idProduct"));
	if (vid === undefined || pid === undefined) return false;
	if (vid.toLowerCase() !== spec.vid.toLowerCase()) return false;
	if (pid.toLowerCase() !== spec.pid.toLowerCase()) return false;
	if (spec.serial === undefined) return true;
	const serial = readSys(base, join(entryRel, "serial"));
	return serial !== undefined && serial === spec.serial;
}

/** Walk up from a resolved path until a dir containing idVendor (a USB device entry). */
function usbAncestorOf(base, resolved) {
	let dir = resolved;
	while (dir && dir.length > base.length) {
		const rel = dir.slice(base.length + 1);
		if (readSys(base, join(rel, "idVendor")) !== undefined) return rel;
		dir = dirname(dir);
	}
	return undefined;
}

/**
 * Nodes under /sys/class/<class> whose USB ancestor matches the spec:
 * hidraw (HID probes) and ttyACM/ttyUSB (CDC/serial probes like esptool).
 */
export function classEntriesFor(base, spec, classDir, nameFilter) {
	const out = [];
	let names;
	try {
		names = readdirSync(join(base, classDir));
	} catch {
		return out;
	}
	for (const name of names) {
		if (nameFilter !== undefined && !nameFilter(name)) continue;
		let target;
		try {
			target = realpathSync(join(base, classDir, name, "device"));
		} catch {
			continue;
		}
		const usbEntry = usbAncestorOf(base, target);
		if (usbEntry === undefined) continue;
		if (!usbEntryMatches(base, usbEntry, spec)) continue;
		out.push(`/dev/${name}`);
	}
	return out;
}

export function hidrawEntriesFor(base, spec) {
	return classEntriesFor(base, spec, "class/hidraw");
}

export function ttyEntriesFor(base, spec) {
	return classEntriesFor(base, spec, "class/tty", (name) => TTY_PREFIXES.some((p) => name.startsWith(p)));
}

/**
 * Candidate device-node paths for one probe spec from sysfs: the usbfs node
 * `/dev/bus/usb/<bus>/<dev>` (zero-padded), plus any matching hidraw and
 * ttyACM/ttyUSB nodes. Pure — does not check that the nodes currently exist.
 */
export function sysfsNodesForSpec(spec, base = "/sys") {
	const nodes = [];
	let usbDir;
	try {
		usbDir = join(base, "bus/usb/devices");
		for (const name of readdirSync(usbDir)) {
			const entryRel = join("bus/usb/devices", name);
			if (!usbEntryMatches(base, entryRel, spec)) continue;
			const busnum = readSys(base, join(entryRel, "busnum"));
			const devnum = readSys(base, join(entryRel, "devnum"));
			if (busnum !== undefined && devnum !== undefined) {
				// usbfs node names are zero-padded to 3 digits: /dev/bus/usb/003/002
				nodes.push(`/dev/bus/usb/${busnum.padStart(3, "0")}/${devnum.padStart(3, "0")}`);
			}
		}
	} catch {
		// sysfs unavailable — no candidates
	}
	nodes.push(...hidrawEntriesFor(base, spec));
	nodes.push(...ttyEntriesFor(base, spec));
	return [...new Set(nodes)];
}

/** Character device (tty, usbfs, hidraw, ...) that exists right now. */
export function isCharDevice(path) {
	try {
		return statSync(path).isCharacterDevice();
	} catch {
		return false;
	}
}

/** Any device node (char or block) that exists right now — for path grants. */
export function isDeviceNode(path) {
	try {
		const st = statSync(path);
		return st.isCharacterDevice() || st.isBlockDevice();
	} catch {
		return false;
	}
}

export function validateNodes(nodes) {
	return nodes.filter((node) => node.startsWith("/dev/") && isCharDevice(node));
}

/**
 * Resolve ONE grant to the device nodes currently present:
 *  - probe spec → sysfs-derived nodes (usbfs + hidraw + tty), char-validated;
 *  - exact path → the path itself when it is a /dev device node.
 * Empty when nothing is attached — the caller injects nothing and the sandbox
 * denies as usual (fail closed).
 */
export function resolveGrantedNodes(grant, base = "/sys") {
	if (grant.path !== undefined) {
		return isDeviceNode(grant.path) ? [grant.path] : [];
	}
	return validateNodes(sysfsNodesForSpec(grant, base));
}

/**
 * Discovery: every attached USB device (non-hub) as `{ vid, pid, serial? }`
 * plus its resolved node count. Powers `/flashdev scan` so a brand-new probe
 * can be authorized without knowing its identity in advance.
 */
export function scanAttachedUsb(base = "/sys") {
	const out = [];
	let usbDir;
	try {
		usbDir = join(base, "bus/usb/devices");
		for (const name of readdirSync(usbDir)) {
			const entryRel = join("bus/usb/devices", name);
			const vid = readSys(base, join(entryRel, "idVendor"));
			const pid = readSys(base, join(entryRel, "idProduct"));
			if (vid === undefined || pid === undefined) continue;
			if (vid.toLowerCase() === "1d6b") continue; // root hubs
			const serial = readSys(base, join(entryRel, "serial"));
			out.push({
				vid,
				pid,
				serial: serial !== undefined && serial.length > 0 ? serial : undefined
			});
		}
	} catch {
		// sysfs unavailable
	}
	return out.sort((a, b) => a.vid.localeCompare(b.vid) || a.pid.localeCompare(b.pid));
}
