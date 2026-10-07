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

const day = () => new Date().toISOString().slice(0, 10);
const addSecs = (src, sec) => {
  const d = day();
  return [['HINCRBY', 'secs', src, sec], ['HINCRBY', 'dsecs:' + d, src, sec], ['EXPIRE', 'dsecs:' + d, 3456000]];
};

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
      ['HINCRBY', 'dviews:' + day(), src, 1],
      ['EXPIRE', 'dviews:' + day(), 3456000],
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
  const sec = Math.max(0, Math.min(Math.round(+b.sec || 0), 600)); // secondes regardées depuis le dernier envoi
  const sid = String(b.sid || '');
  const TTL = 2592000; // 30 jours
  const sess = sec && /^[\w-]{4,40}$/.test(sid) ? [
    ['HINCRBY', 'sv:' + src, sid, sec],
    ['HSETNX', 'ss:' + src, sid, Date.now() - sec * 1000],
    ['HSETNX', 'sw:' + src, sid, vid.slice(0, 6)],
    ['ZADD', 'sl:' + src, Date.now(), sid],
    ['EXPIRE', 'sv:' + src, TTL], ['EXPIRE', 'ss:' + src, TTL], ['EXPIRE', 'sw:' + src, TTL], ['EXPIRE', 'sl:' + src, TTL],
  ] : [];
  const extra = sec ? [...addSecs(src, sec), ...sess] : [];
  try {
    if (b.leave) await redis([['ZREM', 'live', member], ['HSET', 'titles', src, title], ...extra]);
    else await redis([
      ['ZADD', 'live', Date.now(), member],
      ['HSET', 'titles', src, title],
      ...extra,
    ]);
    return new Response(null, { status: 204 });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function stats(only) {
  try {
    if (only) { // détail d'une vidéo : 14 derniers jours
      const days = [], cmds = [];
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        days.push(d);
        cmds.push(['HGET', 'dsecs:' + d, only], ['HGET', 'dviews:' + d, only]);
      }
      cmds.push(['ZREVRANGE', 'sl:' + only, 0, 99, 'WITHSCORES']);
      const r = await redis(cmds);
      const sl = r[r.length - 1] || [], ids = [], lasts = [];
      for (let i = 0; i < sl.length; i += 2) { ids.push(sl[i]); lasts.push(+sl[i + 1]); }
      let sessions = [];
      if (ids.length) {
        const [sv, ss, sw] = await redis([['HMGET', 'sv:' + only, ...ids], ['HMGET', 'ss:' + only, ...ids], ['HMGET', 'sw:' + only, ...ids]]);
        sessions = ids.map((id, i) => ({ id, secs: +sv[i] || 0, start: +ss[i] || 0, last: lasts[i], who: sw[i] || '' }));
      }
      return json({ days: days.map((d, i) => ({ d, secs: +r[i * 2] || 0, views: +r[i * 2 + 1] || 0 })).reverse(), sessions });
    }
    const now = Date.now();
    const [, plays, titles, last, liveRaw, secs] = (await redis([
      ['ZREMRANGEBYSCORE', 'live', '-inf', now - LIVE_TTL],
      ['HGETALL', 'plays'], ['HGETALL', 'titles'], ['HGETALL', 'last'],
      ['ZRANGE', 'live', 0, -1], ['HGETALL', 'secs'],
    ])).map((x, i) => ((i >= 1 && i <= 3) || i === 5 ? toObj(x) : x));
    const liveBy = {};
    let liveTotal = 0;
    for (const m of liveRaw || []) {
      const s = m.slice(m.indexOf('|') + 1);
      liveBy[s] = (liveBy[s] || 0) + 1;
      liveTotal++;
    }
    const srcs = [...new Set([...Object.keys(plays), ...Object.keys(liveBy), ...Object.keys(secs)])];
    const uniq = srcs.length ? await redis(srcs.map(s => ['PFCOUNT', 'uniq:' + s])) : [];
    const videos = srcs.map((s, i) => ({
      src: s, title: titles[s] || '', plays: +plays[s] || 0, viewers: uniq[i] || 0,
      last: +last[s] || 0, live: liveBy[s] || 0, secs: +secs[s] || 0,
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
  if (u.pathname === '/api/stats') return stats(p.get('src'));
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
