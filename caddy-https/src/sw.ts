/**
 * The service worker served at /sw.js (scope / — it controls the whole PWA).
 * Receives push events and shows system notifications; clicking a
 * notification opens the session URL.
 */
export const SW_SOURCE = `'use strict';
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { /* non-JSON push */ }
  const options = {
    body: data.body || '',
    icon: '/plugins/@dsh-external/dsh-mobile/icon.png',
    badge: '/plugins/@dsh-external/dsh-mobile/icon.png',
    tag: data.tag || 'dsh-notice',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'DeepSeek Harness', options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
`
