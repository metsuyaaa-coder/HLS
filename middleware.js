// middleware.js (racine du projet Vercel), tout-en-un : pas besoin de dossier api/.
// Publics : les liens embed (e=1 + lien s=...), /api/view (compteur de vues) et /api/live (spectateurs en direct).
// Protégés par SITE_PASSWORD : la page d'accueil, /stats.html et /api/stats.
export const config = { matcher: ['/', '/index.html', '/stats.html', '/stats', '/api/stats', '/api/view', '/api/live'] };

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function redis(cmds) {
  const url =
    process.env.UPSTASH_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.UPSTASH_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis non configuré (url=' + !!url + ', token=' + !!token + ')');
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('Redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const toObj = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };

async function view(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let b = {};
  try { b = await request.json(); } catch (e) {}
  const src = String(b.src || '').slice(0, 1500);
  const title = String(b.title || '').slice(0, 200);
  const vid = String(b.vid || '').slice(0, 80);
  if (!/^https?:\/\//i.test(src) || !vid) return new Response(null, { status: 400 });
  try {
    await redis([
      ['HINCRBY', 'plays', src, 1],
      ['PFADD', 'uniq:' + src, vid],
      ['HSET', 'titles', src, title],
      ['HSET', 'last', src, Date.now()],
    ]);
    return new Response(null, { status: 204 });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

// Spectateurs en direct : chaque lecteur envoie un "heartbeat" toutes les ~15 s pendant la lecture.
// Un spectateur est compté "en direct" s'il a émis un heartbeat dans les LIVE_TTL dernières ms.
const LIVE_TTL = 40000;
async function live(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let b = {};
  try { b = await request.json(); } catch (e) {}
  const src = String(b.src || '').slice(0, 1500);
  const title = String(b.title || '').slice(0, 200);
  const vid = String(b.vid || '').slice(0, 80);
  if (!/^https?:\/\//i.test(src) || !vid || vid.includes('|')) return new Response(null, { status: 400 });
  const member = vid + '|' + src;
  try {
    if (b.leave) await redis([['ZREM', 'live', member]]);
    else await redis([
      ['ZADD', 'live', Date.now(), member],
      ['HSET', 'titles', src, title],
    ]);
    return new Response(null, { status: 204 });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function stats() {
  try {
    const now = Date.now();
    const [, plays, titles, last, liveRaw] = (await redis([
      ['ZREMRANGEBYSCORE', 'live', '-inf', now - LIVE_TTL],
      ['HGETALL', 'plays'], ['HGETALL', 'titles'], ['HGETALL', 'last'],
      ['ZRANGE', 'live', 0, -1],
    ])).map((x, i) => (i >= 1 && i <= 3 ? toObj(x) : x));
    const liveBy = {};
    let liveTotal = 0;
    for (const m of liveRaw || []) {
      const s = m.slice(m.indexOf('|') + 1);
      liveBy[s] = (liveBy[s] || 0) + 1;
      liveTotal++;
    }
    const srcs = [...new Set([...Object.keys(plays), ...Object.keys(liveBy)])];
    const uniq = srcs.length ? await redis(srcs.map(s => ['PFCOUNT', 'uniq:' + s])) : [];
    const videos = srcs.map((s, i) => ({
      src: s, title: titles[s] || '', plays: +plays[s] || 0, viewers: uniq[i] || 0,
      last: +last[s] || 0, live: liveBy[s] || 0,
    })).sort((a, b) => b.live - a.live || b.plays - a.plays);
    return json({ videos, liveTotal });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

export default async function middleware(request) {
  const u = new URL(request.url), p = u.searchParams;
  if (u.pathname === '/api/view') return view(request);
  if (u.pathname === '/api/live') return live(request);

  const home = u.pathname === '/' || u.pathname === '/index.html';
  const embed = home && (p.get('e') || p.get('embed')) === '1' && (p.get('s') || p.get('src'));
  const pass = process.env.SITE_PASSWORD || '';
  const [scheme, enc] = (request.headers.get('authorization') || '').split(' ');
  let ok = false;
  if (scheme === 'Basic' && enc) {
    try {
      const d = atob(enc);
      ok = !!pass && d.slice(d.indexOf(':') + 1) === pass;
    } catch (e) { ok = false; }
  }
  if (!embed && !ok) return new Response('Accès privé', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Flux"' } });
  if (u.pathname === '/api/stats') return stats();
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
