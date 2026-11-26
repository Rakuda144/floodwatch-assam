// sw.js — Offline-first Service Worker for Assam Flood Monitor
// Caches the app shell and latest CWC river level data (levels.json, stations.json, history.csv)
// so visitors can still view last synced gauges and call 1070 / 1077 during network outages.

const CACHE_NAME = 'assam-flood-monitor-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];
const DATA_FILES = [
  './data/levels.json',
  './data/stations.json',
  './data/history.csv'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL).catch(() => {});
      await Promise.allSettled(
        DATA_FILES.map((url) =>
          fetch(url, { cache: 'no-store' }).then((res) => {
            if (res.ok) return cache.put(url, res);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML & CWC data files so online users always get fresh readings,
  // falling back to cached copies when mobile internet drops.
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      })
  );
});

// =========================================================================
// WEB PUSH NOTIFICATIONS (WL / DL ALERTS FOR USER WATCHLIST)
// =========================================================================
self.addEventListener('push', (event) => {
  let payload = {
    title: 'Assam Flood Monitor Alert',
    body: 'A gauge on your watchlist reported a new water level update.',
    url: './',
    tag: 'assam-flood-alert'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    tag: payload.tag || 'assam-flood-alert',
    renotify: true,
    requireInteraction: payload.severity === 'danger',
    vibrate: payload.severity === 'danger' ? [250, 100, 250, 100, 350] : [200, 100, 200],
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='44' fill='%23071426'/%3E%3Cpath d='M24 114c15-12 30-12 45 0s30 12 45 0 30-12 45 0M24 144c15-12 30-12 45 0s30 12 45 0 30-12 45 0' stroke='%2338bdf8' stroke-width='15' fill='none' stroke-linecap='round'/%3E%3Cpath d='M42 84l54-42 54 42' stroke='%23ffffff' stroke-width='14' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
    badge: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' rx='24' fill='%23071426'/%3E%3Cpath d='M12 58c8-6 16-6 24 0s16 6 24 0 16-6 24 0' stroke='%2338bdf8' stroke-width='8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E",
    data: {
      url: payload.url || './',
      gaugeId: payload.gaugeId || null
    }
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const gaugeId = event.notification.data?.gaugeId;
  const targetUrl = gaugeId ? `./?gauge=${encodeURIComponent(gaugeId)}` : (event.notification.data?.url || './');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if (gaugeId) client.postMessage({ type: 'OPEN_GAUGE', gaugeId });
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
