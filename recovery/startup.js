/**
 * recovery — the command-line provider (subpath export `recovery/startup`).
 *
 * Reads the launcher's immutable argument snapshot and publishes it as the
 * `recoveryStartup` service consumed by the recovery-runner row. Unlike the
 * headless app this is deliberately commander-free: the recovery task is just
 * the joined positional arguments, and there is nothing to `--help` (a missing
 * or blank task is valid — the runner substitutes its built-in recovery
 * prompt). Any flag the user passes is simply treated as part of the task,
 * which keeps `dsh --profile recovery "fix chunk-trim"` working verbatim.
 *
 * @module recovery/startup
 */

/** Stable Cordis plugin name. */
export const name = "recovery-startup";

/** Services required before the task can be resolved. */
const inject = ["cmdlineArgs"];
export { inject };

/** Service provided by this plugin and injected by the recovery-runner. */
export const RECOVERY_STARTUP_SERVICE = "recoveryStartup";

/**
 * Publish the joined positional arguments as the recovery task.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx) {
  const snapshot = ctx.cmdlineArgs?.get?.() ?? [];
  const task = snapshot.join(" ").trim();
  ctx.provide(RECOVERY_STARTUP_SERVICE, { task });
}
