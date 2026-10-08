// middleware.js (racine du projet Vercel), tout-en-un : pas besoin de dossier api/.
// Publics : les liens embed (e=1 + lien s=...), /api/view (compteur de vues) et /api/live (spectateurs en direct).
// /api/meta (GET) est public : le lecteur y lit l'intro / le générique / le titre enregistrés dans la bibliothèque.
// /api/folder (GET) est public : le lecteur y lit la liste des épisodes d'un dossier. /api/report (POST) est public : bouton "Signaler un problème".
// Protégés par SITE_PASSWORD : la page d'accueil, /stats.html, /library.html, /api/stats, /api/library et l'écriture sur /api/meta, /api/reports (lecture des signalements).
export const config = { matcher: ['/', '/index.html', '/stats.html', '/stats', '/api/stats', '/api/view', '/api/live', '/api/meta', '/api/library', '/library.html', '/library', '/api/folder', '/api/report', '/api/reports'] };

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

/* ---------- bibliothèque : réglages par vidéo (titre, intro, générique), lus par le lecteur ---------- */
const okSrc = s => /^https?:\/\//i.test(s) && s.length <= 1500;
const cleanI = x => (/^\d+-\d+$/.test(x) ? x : '');
const cleanF = x => String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
const fkey = n => 'fold:' + n.toLowerCase();
const cleanC = a => (Array.isArray(a) ? a : []).slice(0, 12)
  .map(x => ({ l: String((x && x.l) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || 'Sous-titres', u: String((x && x.u) || '').trim().slice(0, 1500) }))
  .filter(x => okSrc(x.u));
const cleanO = x => (/^\d+(-\d+)?$/.test(x) ? x : '');
// qualités : un lien .m3u8 par qualité (même format que les sous-titres : l = nom, u = lien)
const cleanQ = a => (Array.isArray(a) ? a : []).slice(0, 12)
  .map(x => ({ l: String((x && x.l) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || 'Qualité', u: String((x && x.u) || '').trim().slice(0, 1500) }))
  .filter(x => okSrc(x.u));

async function metaGet(p) {
  const src = String(p.get('src') || '').slice(0, 1500);
  if (!okSrc(src)) return json({});
  try {
    let cur = src, [al, raw] = await redis([['HGET', 'alias', cur], ['HGET', 'meta', cur]]);
    for (let i = 0; al && i < 5; i++) { cur = al; [al, raw] = await redis([['HGET', 'alias', cur], ['HGET', 'meta', cur]]); }
    const o = raw ? JSON.parse(raw) : {};
    if (cur !== src) o.r = cur; // le lien a été modifié : le lecteur bascule sur le nouveau
    return json(o);
  } catch (e) { return json({}); }
}

async function metaPost(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let b = {};
  try { b = await request.json(); } catch (e) {}
  const items = (Array.isArray(b.items) ? b.items : [b]).slice(0, 200)
    .map(x => ({ ...x, src: String((x && x.src) || '').slice(0, 1500) })).filter(x => okSrc(x.src));
  try {
    for (const x of items) { // modification du lien d'une vidéo : tout ce qui la concerne suit, et l'ancien lien redirige
      const ns = String(x.newSrc || '').slice(0, 1500);
      if (x.del || !ns || ns === x.src) continue;
      if (!okSrc(ns)) return json({ error: 'Lien invalide.' }, 400);
      const [e1, e2] = await redis([['HEXISTS', 'meta', ns], ['HEXISTS', 'plays', ns]]);
      if (e1 || e2) return json({ error: 'Ce lien existe déjà dans la bibliothèque.' }, 409);
      const old = x.src, rc = [];
      const vals = await redis(['meta', 'plays', 'titles', 'last', 'secs'].map(h => ['HGET', h, old]));
      ['meta', 'plays', 'titles', 'last', 'secs'].forEach((h, i) => { if (vals[i] != null) rc.push(['HSET', h, ns, vals[i]], ['HDEL', h, old]); });
      ['uniq:', 'sv:', 'ss:', 'sw:', 'sl:'].forEach(k => rc.push(['RENAME', k + old, k + ns]));
      let om = {};
      try { om = vals[0] ? JSON.parse(vals[0]) : {}; } catch (e) {}
      if (om.f) rc.push(['SREM', fkey(om.f), old], ['SADD', fkey(om.f), ns]);
      rc.push(['HDEL', 'alias', ns], ['HSET', 'alias', old, ns]);
      await redis(rc);
      x.src = ns;
    }
    const del = items.filter(x => x.del).map(x => x.src);
    const upd = items.filter(x => !x.del);
    const cmds = [];
    const all = [...new Set(items.map(x => x.src))];
    const [curAll] = all.length ? await redis([['HMGET', 'meta', ...all]]) : [[]];
    const curOf = {};
    all.forEach((s, i) => { try { curOf[s] = curAll[i] ? JSON.parse(curAll[i]) : {}; } catch (e) { curOf[s] = {}; } });
    if (upd.length) {
      const args = [];
      upd.forEach(x => {
        const m = curOf[x.src] || {};
        if (typeof x.title === 'string') { if (x.title.trim()) m.t = x.title.trim().slice(0, 200); else delete m.t; }
        if (typeof x.intro === 'string' && (x.intro === '' || cleanI(x.intro))) m.i = cleanI(x.intro); // valeur invalide : ignorée
        if (typeof x.outro === 'string' && (x.outro === '' || cleanO(x.outro))) m.o = cleanO(x.outro);
        if (Array.isArray(x.subs)) { const c = cleanC(x.subs); if (c.length) m.c = c; else delete m.c; } // sous-titres de la bibliothèque
        if (Array.isArray(x.quals)) m.q = cleanQ(x.quals); // qualités de la bibliothèque ([] = aucune, même si le lien partagé en contenait)
        if (typeof x.folder === 'string') { // dossier : '' = sortir du dossier
          const nf = cleanF(x.folder), of = m.f || '';
          if (nf.toLowerCase() !== of.toLowerCase() || nf !== of) {
            if (of) cmds.push(['SREM', fkey(of), x.src]);
            if (nf) { cmds.push(['SADD', fkey(nf), x.src]); m.f = nf; } else delete m.f;
          } else if (nf) cmds.push(['SADD', fkey(nf), x.src]);
        }
        m.u = Date.now();
        args.push(x.src, JSON.stringify(m));
      });
      cmds.push(['HSET', 'meta', ...args]);
    }
    if (del.length) {
      del.forEach(s => { const f = (curOf[s] || {}).f; if (f) cmds.push(['SREM', fkey(f), s]); });
      cmds.push(['HDEL', 'meta', ...del]);
    }
    if (cmds.length) await redis(cmds);
    return json({ ok: true, n: items.length });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function folderGet(p) {
  const name = cleanF(p.get('f'));
  if (!name) return json({ items: [] });
  try {
    const [mem] = await redis([['SMEMBERS', fkey(name)]]);
    const srcs = (mem || []).filter(okSrc).slice(0, 300);
    if (!srcs.length) return json({ name, items: [] });
    const [metas, titles] = await redis([['HMGET', 'meta', ...srcs], ['HMGET', 'titles', ...srcs]]);
    const items = srcs.map((s, i) => {
      let m = {};
      try { m = metas[i] ? JSON.parse(metas[i]) : {}; } catch (e) {}
      return { src: s, title: m.t || titles[i] || '', intro: m.i || '', outro: m.o || '' };
    });
    return json({ name, items });
  } catch (e) { return json({ items: [] }); }
}

const KINDS = ['Pas de son', 'Sous-titres', 'Image qui saccade', 'Qualité', 'Ne démarre pas', 'Mauvais épisode', 'Autre'];
async function reportPost(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let b = {};
  try { b = await request.json(); } catch (e) {}
  const src = String(b.src || '').slice(0, 1500);
  const vid = String(b.vid || '').slice(0, 80);
  if (!okSrc(src) || !vid) return new Response(null, { status: 400 });
  const kind = KINDS.includes(b.kind) ? b.kind : 'Autre';
  const msg = String(b.msg || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
  try {
    const [ok] = await redis([['SET', 'rl:' + vid, 1, 'NX', 'EX', 15]]);
    if (!ok) return json({ error: 'Trop de signalements, réessaie dans quelques secondes.' }, 429);
    const r = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), src,
      title: String(b.title || '').slice(0, 200), kind, msg,
      pos: Math.max(0, Math.round(+b.pos || 0)), ua: String(request.headers.get('user-agent') || '').slice(0, 140),
    };
    await redis([['LPUSH', 'reports', JSON.stringify(r)], ['LTRIM', 'reports', 0, 199]]);
    return new Response(null, { status: 204 });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function reports(request) {
  try {
    if (request.method === 'POST') {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      if (b.clear) { await redis([['DEL', 'reports']]); return json({ ok: true }); }
      if (b.del) {
        const [raw] = await redis([['LRANGE', 'reports', 0, 199]]);
        const hit = (raw || []).find(x => { try { return JSON.parse(x).id === b.del; } catch (e) { return false; } });
        if (hit) await redis([['LREM', 'reports', 1, hit]]);
        return json({ ok: true });
      }
      return json({ ok: false }, 400);
    }
    const [raw] = await redis([['LRANGE', 'reports', 0, 199]]);
    const items = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    return json({ items });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

async function library() {
  try {
    const [meta, plays, titles, last, secs] = (await redis([
      ['HGETALL', 'meta'], ['HGETALL', 'plays'], ['HGETALL', 'titles'], ['HGETALL', 'last'], ['HGETALL', 'secs'],
    ])).map(toObj);
    const srcs = [...new Set([...Object.keys(meta), ...Object.keys(plays), ...Object.keys(titles)])];
    const videos = srcs.map(s => {
      let m = {};
      try { m = meta[s] ? JSON.parse(meta[s]) : {}; } catch (e) {}
      return {
        src: s, title: m.t || titles[s] || '', folder: m.f || '', subs: m.c || [], quals: m.q || [], intro: m.i === undefined ? null : m.i, outro: m.o === undefined ? null : m.o,
        saved: !!meta[s], updated: m.u || 0, plays: +plays[s] || 0, secs: +secs[s] || 0, last: +last[s] || 0,
      };
    }).sort((a, b) => Math.max(b.updated, b.last) - Math.max(a.updated, a.last));
    return json({ videos });
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
  if (u.pathname === '/api/meta' && request.method === 'GET') return metaGet(p);
  if (u.pathname === '/api/folder' && request.method === 'GET') return folderGet(p);
  if (u.pathname === '/api/report') return reportPost(request);

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
  if (u.pathname === '/api/library') return library();
  if (u.pathname === '/api/reports') return reports(request);
  if (u.pathname === '/api/meta') return metaPost(request);
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
