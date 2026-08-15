/**
 * Web Push plumbing for caddy-https: VAPID key management, subscription
 * storage, and notification delivery through the standard Web Push protocol
 * (on iOS this rides APNs via web.push.apple.com).
 *
 * All state persists under ~/.dsh/caddy-https/ so harness reinstalls never
 * drop keys or subscriptions.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'

/** A stored push subscription (the raw browser subscription + context). */
export interface StoredSubscription {
  /** The push endpoint (also the storage key). */
  endpoint: string
  /** Browser subscription keys (p256dh, auth). */
  keys: { p256dh: string; auth: string }
  /** Session that subscribed, when known (used to target pushes). */
  sessionId?: string
  /** Epoch ms of first subscription. */
  createdAt: number
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

function dataDir(): string {
  return join(homedir(), '.dsh', 'caddy-https')
}

/** VAPID `sub` claim. Apple's web.push.apple.com rejects a localhost
 *  subject (BadJwtToken), so this is set from the configured public host at
 *  apply time — the hostname lives in the local profile, never in the repo. */
let vapidContact = 'mailto:webpush@localhost'

/** Point the VAPID subject at the real public host (called with the plugin
 *  config host; a no-op for an empty host). */
export function setPushContact(host: string): void {
  if (host !== '') vapidContact = `mailto:webpush@${host}`
}

/** Load VAPID keys, generating and persisting them on first use. */
export async function loadVapidKeys(): Promise<VapidKeys> {
  const dir = dataDir()
  const file = join(dir, 'vapid.json')
  if (existsSync(file)) {
    return JSON.parse(await readFile(file, 'utf8')) as VapidKeys
  }
  const keys = webpush.generateVAPIDKeys()
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(keys, null, 2))
  return keys
}

async function loadSubscriptions(): Promise<Record<string, StoredSubscription>> {
  try {
    return JSON.parse(await readFile(join(dataDir(), 'subscriptions.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function saveSubscriptions(subs: Record<string, StoredSubscription>): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(join(dataDir(), 'subscriptions.json'), JSON.stringify(subs, null, 2))
}

/** Persist one subscription (idempotent per endpoint). */
export async function addSubscription(sub: StoredSubscription): Promise<void> {
  const subs = await loadSubscriptions()
  subs[sub.endpoint] = sub
  await saveSubscriptions(subs)
}

/** Remove a subscription by endpoint. */
export async function removeSubscription(endpoint: string): Promise<void> {
  const subs = await loadSubscriptions()
  if (endpoint in subs) {
    delete subs[endpoint]
    await saveSubscriptions(subs)
  }
}

/** All stored subscriptions. */
export async function listSubscriptions(): Promise<StoredSubscription[]> {
  return Object.values(await loadSubscriptions())
}

export interface PushPayload {
  title: string
  body?: string
  tag?: string
  url?: string
}

/**
 * Deliver a notification to every stored subscription. Stale endpoints
 * (410 Gone / 404) are pruned as they fail.
 */
export async function pushToAll(payload: PushPayload): Promise<{ sent: number; dropped: number }> {
  const keys = await loadVapidKeys()
  webpush.setVapidDetails(vapidContact, keys.publicKey, keys.privateKey)
  const subs = await listSubscriptions()
  let sent = 0
  let dropped = 0
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
      )
      sent += 1
    } catch (error) {
      const code = (error as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) {
        await removeSubscription(sub.endpoint)
        dropped += 1
      }
      // Other failures (network, transient 429/5xx) are left for the next send.
    }
  }
  return { sent, dropped }
}
