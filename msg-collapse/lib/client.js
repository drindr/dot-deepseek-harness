/**
 * msg-collapse — browser half (module-loader bundle, served at
 * /plugins/msg-collapse/client.js).
 *
 * Collapses long user messages (typically large pasted text) in the
 * conversation view. Design:
 *
 *   - Overrides the keyed `conversation.chat.node` slot cell for the "user"
 *     key at priority -100 ("lowest renders" — the shadowing rule), with a
 *     wrapper around the BUILT-IN user-message renderer. The built-in
 *     component is read from `ctx.slots.entries("conversation.chat.node")`
 *     at apply time, so the bubble (copy action, images, links, JsonBlocks)
 *     is rendered unchanged — nothing is replicated.
 *   - The wrapper only kicks in when the message's text exceeds
 *     `COLLAPSE_CHARS`: it clamps the bubble to `COLLAPSE_MAX_HEIGHT` with a
 *     fade and a "expand / collapse" pill (localized via the entry's locale),
 *     and toggles on click. Normal messages render the built-in directly
 *     with zero extra DOM.
 *   - Clicking a link, button, or image inside the bubble passes through
 *     (the toggle is skipped when the event target is interactive, or when
 *     the user is selecting text).
 *
 * The bundle is hand-written in the module-loader contract; only `react` is
 * resolved through the loader's module table.
 */
window.__ModuleLoader__.load({
  id: "msg-collapse",
  factory: function (require) {
    const React = require("react");
    const { memo, useCallback, useState } = React;

    const NS = "msg-collapse";
    /** Collapse once the message text exceeds this many characters. */
    const COLLAPSE_CHARS = 500;
    /** Clamped height of a collapsed message. */
    const COLLAPSE_MAX_HEIGHT = "12em";
    /** Priority used to shadow the built-in "user" renderer (lowest wins). */
    const SHADOW_PRIORITY = -100;

    const zh = {
      "expand": "展开全文",
      "collapse": "收起"
    };
    const en = {
      "expand": "Expand",
      "collapse": "Collapse"
    };

    const name = "msg-collapse";

    /** Client services the browser half needs. */
    const inject = ["slots", "locale"];

    const CSS = [
      `[data-pl-msg-collapse]{position:relative;max-height:${COLLAPSE_MAX_HEIGHT};overflow:hidden;cursor:pointer}`,
      `[data-pl-msg-collapse]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4em;background:linear-gradient(transparent,var(--dsw-alias-bg-base, #fff));pointer-events:none}`,
      `[data-pl-msg-collapse]::before{content:attr(data-pl-label);position:absolute;left:50%;bottom:.4em;transform:translateX(-50%);z-index:1;font-size:12px;line-height:1;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid, #eee);color:var(--dsw-alias-label-secondary);pointer-events:none}`,
      `[data-pl-msg-collapse][data-pl-msg-open]{max-height:none;overflow:visible;cursor:auto}`,
      `[data-pl-msg-collapse][data-pl-msg-open]::after,[data-pl-msg-collapse][data-pl-msg-open]::before{display:none}`
    ].join("\n");

    /** Total text length across the message content blocks. */
    function textLength(content) {
      if (!Array.isArray(content)) return 0;
      let total = 0;
      for (const block of content) {
        if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          total += block.text.length;
        }
      }
      return total;
    }

    /**
     * Build the shadowing renderer: a memoized wrapper around the built-in
     * user-message node view.
     */
    function CollapsibleUserMessage(builtin) {
      return memo(function UserMessageCollapse(props) {
        const long = textLength(props.node?.data?.content) > COLLAPSE_CHARS;
        const [open, setOpen] = useState(false);
        const onToggle = useCallback((event) => {
          // Let links, buttons, images, and text selection pass through.
          if (event.target instanceof Element && event.target.closest("a, button")) return;
          const selection = window.getSelection?.();
          if (selection !== void 0 && selection.toString().length > 0) return;
          setOpen((value) => !value);
        }, []);
        if (!long) return React.createElement(builtin, props);
        return React.createElement(
          "div",
          {
            "data-pl-msg-collapse": "1",
            "data-pl-msg-open": open ? "1" : void 0,
            "data-pl-label": open ? props.t?.("collapse") ?? "收起" : props.t?.("expand") ?? "展开全文",
            onClick: onToggle,
            role: "button",
            "aria-expanded": open
          },
          React.createElement(builtin, props)
        );
      });
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", NS);
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "msg-collapse: styles");

      ctx.effect(() => {
        ctx.locale.register(NS, { zh, en });
      }, "msg-collapse: dictionaries");

      /** Register the shadowing entry once the built-in "user" renderer exists. */
      const registerShadow = () => {
        const entries = ctx.slots.entries("conversation.chat.node");
        const builtin = entries.find((entry) => entry.options.key === "user" && (entry.options.priority ?? 0) !== SHADOW_PRIORITY)?.component;
        if (builtin === void 0) return false;
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key: "user",
          priority: SHADOW_PRIORITY,
          locale: NS
        }, CollapsibleUserMessage(builtin)));
        return true;
      };

      if (registerShadow()) return;
      // The conversation package registers its renderers when its apply runs;
      // if that has not happened yet, retry on the slot's change feed.
      let unsub = () => {};
      unsub = ctx.slots.subscribe("conversation.chat.node", () => {
        if (registerShadow()) unsub();
      });
      ctx.effect(() => unsub, "msg-collapse: wait for built-in user renderer");
    }

    return { name, inject, apply };
  },
});
