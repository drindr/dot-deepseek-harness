/**
 * page-lazy — browser half (module-loader bundle, served at
 * /plugins/page-lazy/client.js).
 *
 * dsh 0.1.2 rewrite: the adaptive page-size half was removed. The old
 * `session.history({maxMessages})` seam is gone — paging now lives in a
 * private SessionEventStream with a hardcoded PAGE_MESSAGES=50, and the
 * 0.1.2 host packs streaming `assistant/chunk` deltas natively
 * (dsh-session/chunk-rows, ~56× envelope reduction in both persistence and
 * history transport), so the page-weight problem the size policy managed no
 * longer exists. What remains valuable and has no native equivalent is the
 * idle prefetch:
 *
 *   Idle prefetch
 *     After a real cold→open transition, schedule ONE loadOlder() in idle
 *     (requestIdleCallback; setTimeout fallback). The prefetched page goes
 *     through the same anchor-preserving loadOlder path as the manual
 *     button, so the reader's scroll position is untouched. It fires once
 *     per cold→open transition (later open() calls on an already-open
 *     session are skipped via `wasOpen`), and a reconnect resync re-arms it
 *     naturally — so the download is bounded to one page per open and never
 *     cascades.
 *
 *   Trigger surface
 *     The manual "load earlier" button remains as the deep-dive affordance.
 *     Scroll-proximity auto-load is a UI-layer change (the conversation
 *     scrollport is owned by ChatView) — noted in the README as follow-up.
 *
 * No runtime imports: the bundle is hand-written in the module-loader
 * contract and resolves nothing through the loader table.
 */
window.__ModuleLoader__.load({
  id: "page-lazy",
  factory: function (require) {
    /** Idle-prefetch fallback delay when requestIdleCallback is unavailable. */
    const IDLE_FALLBACK_MS = 800;

    const name = "page-lazy";

    /** The client runtime's session manager must be mounted. */
    const inject = ["sessions"];

    function scheduleIdle(fn) {
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(fn, { timeout: 3000 });
        return () => cancelIdleCallback(id);
      }
      const id = setTimeout(fn, IDLE_FALLBACK_MS);
      return () => clearTimeout(id);
    }

    /**
     * Wrap one Session instance (instance-property shadowing of the class
     * prototype methods — the manager hands out fresh instances per session).
     * Session.open / openState / hasMore / loadingOlder / loadOlder verified
     * against dsh-api-session-controller 0.1.2-rc.1.
     */
    function wrapSession(session) {
      if (session.__pageLazyWrapped === true) return;
      session.__pageLazyWrapped = true;

      const originalOpen = session.open;

      // Idle prefetch after a real cold→open transition.
      session.open = function (...args) {
        const wasOpen = this.openState === "open";
        const result = originalOpen.apply(this, args);
        if (result !== void 0 && typeof result.then === "function") {
          result
            .then(() => {
              if (wasOpen) return;
              if (this.openState !== "open" || !this.hasMore) return;
              scheduleIdle(() => {
                if (this.loadingOlder || !this.hasMore) return;
                this.loadOlder().catch(() => {});
              });
            })
            .catch(() => {});
        }
        return result;
      };
    }

    function apply(ctx) {
      // ponytail: harness moved the manager behind SessionRuntime.manager (TS-private,
      // plain property at runtime); keep both shapes working.
      const manager = ctx.sessions.manager ?? ctx.sessions;
      if (typeof manager.get !== "function") return;
      const originalGet = manager.get.bind(manager);
      manager.get = (sessionId) => {
        const session = originalGet(sessionId);
        wrapSession(session);
        return session;
      };
      ctx.effect(() => {
        manager.get = originalGet;
      }, "page-lazy: restore sessions manager get");
    }

    return { name, inject, apply };
  },
});
