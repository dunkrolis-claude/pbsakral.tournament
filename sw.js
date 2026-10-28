/* PB Sakral — service worker halaman pemain.
   Tujuan: halaman tetap terbuka saat sinyal jelek di lokasi.
   - Halaman utama: jaringan dulu (maks 4 dtk), jika lambat/gagal pakai salinan terakhir.
   - Skrip/aset (termasuk esm.sh): pakai salinan tersimpan, perbarui di belakang layar.
   - /api/* dan database TIDAK pernah disentuh (data diurus cache aplikasi). */
const V = "pbs-shell-v1";
const EXTRA_HOSTS = ["esm.sh"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then((c) => c.add("/")).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

async function networkFirstShell(req) {
  const cache = await caches.open(V);
  try {
    const res = await Promise.race([fetch(req), timeout(4000)]);
    if (res && res.ok) cache.put("/", res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match("/", { ignoreVary: true });
    if (hit) return hit;
    return fetch(req);
  }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(V);
  const hit = await cache.match(req, { ignoreVary: true });
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  const same = u.origin === self.location.origin;
  if (same && u.pathname.startsWith("/api/")) return;
  if (!same && !EXTRA_HOSTS.includes(u.hostname)) return;
  if (req.mode === "navigate") { e.respondWith(networkFirstShell(req)); return; }
  e.respondWith(staleWhileRevalidate(req));
});
