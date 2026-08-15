/**
 * page-lazy — browser half (module-loader bundle, served at
 * /plugins/page-lazy/client.js).
 *
 * Rationale: after chunk-trim, a 50-message history page is ~372 events /
 * ~650 KB — cheap per page, so the remaining lever is *when* and *how much*
 * the client pulls. This plugin makes the pagination policy adaptive and
 * warms the scroll-up path:
 *
 *   1. Page sizes
 *      - first open page: 30 messages (fast first paint, ~260 events);
 *      - every later page (loadOlder, and doOpen's live re-pull): 50.
 *      Discriminator: `beforeSeq` is undefined AND the window is empty ⇒ the
 *      true first open; anything else keeps 50 (the re-pull after a live
 *      update must NOT shrink an already-installed window).
 *
 *   2. Idle prefetch
 *      After a real cold→open transition, schedule ONE loadOlder() in idle
 *      (requestIdleCallback; setTimeout fallback). The prefetched page goes
 *      through the same anchor-preserving loadOlder path as the manual
 *      button, so the reader's scroll position is untouched. It fires once
 *      per cold→open transition (later open() calls on an already-open
 *      session are skipped via `wasOpen`), and a reconnect resync re-arms it
 *      naturally — so the download is bounded to one page per open and never
 *      cascades.
 *
 *   3. Trigger surface
 *      The manual "load earlier" button remains as the deep-dive affordance.
 *      Scroll-proximity auto-load is a UI-layer change (the conversation
 *      scrollport is owned by ChatView) — noted in the README as follow-up.
 *
 * No runtime imports: the bundle is hand-written in the module-loader
 * contract and resolves nothing through the loader table.
 */
window.__ModuleLoader__.load({
  id: "page-lazy",
  factory: function (require) {
    /** Messages on the first open page (fast first paint). */
    const FIRST_PAGE = 30;
    /** Messages on every later page. */
    const PAGE_SIZE = 50;
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
     */
    function wrapSession(session) {
      if (session.__pageLazyWrapped === true) return;
      session.__pageLazyWrapped = true;

      const originalHistory = session.history;
      const originalOpen = session.open;

      // 1. Page-size policy.
      session.history = function (payload) {
        const isFirstOpen = payload.beforeSeq === void 0 && this.events.length === 0;
        const page = isFirstOpen ? FIRST_PAGE : PAGE_SIZE;
        return originalHistory.call(this, { ...payload, maxMessages: page });
      };

      // 2. Idle prefetch after a real cold→open transition.
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
