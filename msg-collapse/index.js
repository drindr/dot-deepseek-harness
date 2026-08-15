/**
 * msg-collapse — node half (host row).
 *
 * The browser half lives at exports["./client"] and is served by the modules
 * node (dsh.client declaration). All behavior is client-side (collapsible
 * long user messages in the conversation), so this half is intentionally a
 * no-op: it only needs to be a valid cordis plugin for the loader to apply.
 */
export const name = "msg-collapse";

export function apply() {}
