/**
 * caddy-https browser half: registers the push service worker and surfaces a
 * one-tap "enable notifications" toggle on phones.
 *
 * The notification chain needs a SECURE CONTEXT (the caddy-https HTTPS front
 * + device-trusted root CA) and, on iOS, a home-screen PWA (standalone
 * launch) — pushManager.subscribe fails with NotAllowedError from a plain
 * browser tab. The toggle's failure copy says so.
 */
const API = '/plugins/caddy-https/push'

export const name = 'caddy-https'

/** Whether the app is running as an installed PWA (iOS Safari reports the
 *  legacy `standalone` flag; Chromium the display-mode media query). */
function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true
}

/** Convert a base64url VAPID key into the Uint8Array pushManager wants. */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function fetchVapidKey(): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const res = await fetch(`${API}/vapid-public-key`)
    if (!res.ok) return null
    const body = (await res.json()) as { key?: string }
    return typeof body.key === 'string' ? base64UrlToBytes(body.key) : null
  } catch {
    return null
  }
}

async function subscribePush(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
    const registration = await navigator.serviceWorker.ready
    const key = await fetchVapidKey()
    if (key === null) return false
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
    const res = await fetch(`${API}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.getKey('p256dh') ? bytesToBase64Url(subscription.getKey('p256dh')!) : '',
          auth: subscription.getKey('auth') ? bytesToBase64Url(subscription.getKey('auth')!) : '',
        },
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function existingSubscription(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
    const registration = await navigator.serviceWorker.ready
    return (await registration.pushManager.getSubscription()) !== null
  } catch {
    return false
  }
}

const BANNER_STYLE = [
  'position:fixed', 'top:calc(env(safe-area-inset-top, 0px) + 8px)',
  'left:12px', 'right:12px', 'z-index:70',
  'display:flex', 'align-items:center', 'gap:8px', 'justify-content:center',
  'padding:12px 16px', 'border:1px solid rgba(128,128,128,0.35)', 'border-radius:14px',
  'background:#202024', 'color:#eee', 'font-size:14px', 'line-height:20px',
  'min-height:44px', 'cursor:pointer', 'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
].join(';')

async function installToggle(): Promise<void> {
  if (Notification.permission === 'denied') return
  if (Notification.permission === 'granted' && (await existingSubscription())) return
  const banner = document.createElement('button')
  banner.type = 'button'
  banner.style.cssText = BANNER_STYLE
  banner.dataset.dshmNotifyBanner = ''
  banner.textContent = '🔔 开启系统通知（审批 / 任务提醒）'
  banner.addEventListener('click', async () => {
    banner.disabled = true
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      banner.textContent = '通知被拒绝 — 请在系统设置中开启后重试'
      banner.disabled = false
      return
    }
    if (!isStandalone()) {
      banner.textContent = '请先将 DSH 添加到主屏幕，从主屏打开后再开启通知'
      banner.disabled = false
      return
    }
    const ok = await subscribePush()
    if (ok) {
      banner.textContent = '通知已开启 ✓'
      window.setTimeout(() => banner.remove(), 2000)
    } else {
      banner.textContent = '订阅失败，请重试'
      banner.disabled = false
    }
  })
  document.body.append(banner)
}

export function apply(): void {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
  // Register early so push events can arrive; the toggle only shows on
  // narrow viewports (the phone is the notification target).
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
  if (!matchMedia('(max-width: 768px)').matches) return
  void installToggle()
}
