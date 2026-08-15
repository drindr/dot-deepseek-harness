/**
 * Harness event triggers for Web Push notifications. Subscribes to the
 * host `session/event` firehose (live appends only — constructor seeds do
 * not emit, which is exactly right: we want fresh asks, not replays) and
 * pushes system notifications for:
 *   - `approval/asked` — a session is waiting on the user's approval;
 *   - agent idle after a completed turn — "task finished" (a turn/end with
 *     reason `completed` followed by no new turn/start within a quiet
 *     window, so mid-task turn boundaries never fire; throttled per session).
 */
import type { Context } from '@deepseek-ai/cordis'
import { pushToAll, type PushPayload } from './push.ts'

/** The session event firehose payload (session log event). */
interface SessionLogEvent {
  seq: number
  type: string
  data: { reason?: { kind?: string }; [key: string]: unknown }
}

/** Session store entry shape (the first callback argument). */
interface SessionEntry {
  id: string
  header?: { title?: string }
}

/** The dsh web URL that opens a session (root page; the shell resolves the
 *  session from the query). */
function sessionUrl(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`
}

function sessionTitle(session: SessionEntry): string {
  return session.header?.title ?? 'DSH 会话'
}

function payloadForAsk(session: SessionEntry, event: SessionLogEvent): PushPayload {
  const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : '工具'
  const reason = typeof event.data.reason === 'string' ? event.data.reason : undefined
  return {
    title: `DSH · ${sessionTitle(session)} 等待批准`,
    body: reason !== undefined ? `${toolName}：${reason}` : `${toolName} 请求你的批准`,
    tag: `approval-${String(event.data.id ?? event.seq)}`,
    url: sessionUrl(session.id),
  }
}

/** After a turn/end(completed), wait this long for a new turn/start before
 *  declaring the agent idle — long enough that an agent continuing straight
 *  into its next turn cancels the "finished" notification. */
const IDLE_QUIET_MS = 8_000
/** Per-session throttle: at most one "task finished" push per window. */
const FINISHED_THROTTLE_MS = 5 * 60_000

/**
 * Register the push triggers. Returns the disposer.
 */
export function registerPushTriggers(ctx: Context): () => void {
  const events = ctx as unknown as {
    on(event: string, handler: unknown): unknown
    off(event: string, handler: unknown): unknown
  }

  /** sessionId → pending idle-check timer. */
  const idleChecks = new Map<string, ReturnType<typeof setTimeout>>()
  /** sessionId → last "finished" push time (throttle). */
  const lastFinished = new Map<string, number>()

  const onSessionEvent = (session: SessionEntry, event: SessionLogEvent): void => {
    // A new turn begins: any pending idle check for this session is void.
    if (event.type === 'turn/start') {
      const timer = idleChecks.get(session.id)
      if (timer !== undefined) {
        clearTimeout(timer)
        idleChecks.delete(session.id)
      }
      return
    }

    if (event.type === 'approval/asked') {
      void pushToAll(payloadForAsk(session, event)).catch((error) => {
        console.warn(`[caddy-https] approval push failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    // A completed turn: arm the idle check. The agent is "done" only when no
    // new turn/start follows within the quiet window.
    if (event.type === 'turn/end' && event.data.reason?.kind === 'completed') {
      const pending = idleChecks.get(session.id)
      if (pending !== undefined) clearTimeout(pending)
      const timer = setTimeout(() => {
        idleChecks.delete(session.id)
        const now = Date.now()
        const last = lastFinished.get(session.id) ?? 0
        if (now - last < FINISHED_THROTTLE_MS) return
        lastFinished.set(session.id, now)
        void pushToAll({
          title: `DSH · ${sessionTitle(session)} 任务完成`,
          body: 'Agent 已处理完当前任务',
          tag: `finished-${session.id}`,
          url: sessionUrl(session.id),
        }).catch((error) => {
          console.warn(`[caddy-https] finished push failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, IDLE_QUIET_MS)
      idleChecks.set(session.id, timer)
    }
  }

  events.on('session/event', onSessionEvent)
  return () => {
    events.off('session/event', onSessionEvent)
    for (const timer of idleChecks.values()) clearTimeout(timer)
    idleChecks.clear()
    lastFinished.clear()
  }
}
