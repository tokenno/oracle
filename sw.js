const CACHE_NAME = 'oracle-audio-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/audio/sample.mp3' // Include any critical audio samples
];

// Install Event - Cache essential assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Fetch Event - Network falling back to cache
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
      .catch(() => {
        // Special handling for audio files
        if (event.request.url.includes('.mp3')) {
          return caches.match('/audio/sample.mp3');
        }
        return caches.match('/offline.html'); // Create this fallback page
      })
  );
});

// Activate Event - Clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => 
      Promise.all(
        keys.map(key => 
          key !== CACHE_NAME ? caches.delete(key) : null
        )
      )
    ).then(() => self.clients.claim())
  );
});