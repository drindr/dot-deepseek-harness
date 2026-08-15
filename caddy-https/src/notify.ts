/**
 * Harness event triggers for Web Push notifications. Subscribes to the
 * host `session/event` firehose (live appends only — constructor seeds do
 * not emit, which is exactly right: we want fresh asks, not replays) and
 * pushes a system notification when a session asks the user for approval.
 */
import type { Context } from '@deepseek-ai/cordis'
import { pushToAll, type PushPayload } from './push.ts'

/** The session event firehose payload (session log event). */
interface SessionLogEvent {
  seq: number
  type: string
  data: Record<string, unknown>
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

function payloadForAsk(session: SessionEntry, event: SessionLogEvent): PushPayload {
  const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : '工具'
  const reason = typeof event.data.reason === 'string' ? event.data.reason : undefined
  const title = session.header?.title ?? 'DSH 会话'
  return {
    title: `DSH · ${title} 等待批准`,
    body: reason !== undefined ? `${toolName}：${reason}` : `${toolName} 请求你的批准`,
    tag: `approval-${String(event.data.id ?? event.seq)}`,
    url: sessionUrl(session.id),
  }
}

/**
 * Register the approval-ask push trigger. Returns the disposer.
 *
 * Task-completion notifications are intentionally not wired here yet: a
 * reliable "the agent went idle" signal needs the running-state fold, and a
 * naive turn/end trigger would fire per turn. Wired once the approval path
 * is verified on-device.
 */
export function registerPushTriggers(ctx: Context): () => void {
  // cordis routes arbitrary runtime events through ctx.on/off, but its
  // Context type only lists declared event keys — narrow through an assert.
  const events = ctx as unknown as {
    on(event: string, handler: unknown): unknown
    off(event: string, handler: unknown): unknown
  }
  const onSessionEvent = (session: SessionEntry, event: SessionLogEvent): void => {
    if (event.type !== 'approval/asked') return
    void pushToAll(payloadForAsk(session, event)).catch((error) => {
      console.warn(`[caddy-https] approval push failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  events.on('session/event', onSessionEvent)
  return () => {
    events.off('session/event', onSessionEvent)
  }
}
