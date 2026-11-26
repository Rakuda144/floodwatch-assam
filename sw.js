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
