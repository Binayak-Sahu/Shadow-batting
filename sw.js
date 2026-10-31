// sw.js — offline cache. Bump CACHE_VERSION whenever you change any app file,
// so phones fetch the new version.
const CACHE_VERSION = 'shadow-mirror-v1.0.0';
const MP_VERSION = '0.10.14'; // keep in sync with config.js
const MP = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;

// App files: must all download, or the install fails (and retries next visit).
const APP_FILES = [
  './', './index.html', './styles.css', './app.js', './pose.js', './metrics.js',
  './replay.js', './config.js', './pipeline.js', './manifest.json', './icon.svg', './test.html', './lab.html',
];
// Big library/model files: fetched best-effort at install, and also cached
// the first time the app uses them.
const BIG_FILES = [
  `${MP}/vision_bundle.mjs`,
  `${MP}/wasm/vision_wasm_internal.js`,
  `${MP}/wasm/vision_wasm_internal.wasm`,
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
];
const CACHE_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_FILES);
    await Promise.allSettled(BIG_FILES.map(async (url) => {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shadow-mirror-') && k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const bigHost = CACHE_HOSTS.includes(url.hostname);
  if (!sameOrigin && !bigHost) return;

  if (bigHost) {
    // Cache first: these files never change for a pinned version.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // App files: network first (so updates show up), fall back to cache offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
