// App shell only. Ciphertext API responses and all write requests bypass this cache.
const CACHE = 'clprotext-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if(key.startsWith('clprotext-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request=event.request, url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || url.pathname.startsWith('/api/') || url.pathname.includes('signin') || url.pathname.includes('signout') || url.pathname.includes('callback')) return;
  const navigation=request.mode==='navigate';
  const asset=['script','style','font','image'].includes(request.destination);
  if(!navigation && !asset) return;
  event.respondWith((async()=> {
    const cache=await caches.open(CACHE);
    try { const response=await fetch(request); if(response.ok && response.type==='basic' && !response.redirected) await cache.put(request,response.clone()); return response; }
    catch { return (await cache.match(request)) || new Response('Offline: open this notebook online once to cache its app shell.',{status:503,headers:{'Content-Type':'text/plain'}}); }
  })());
});
