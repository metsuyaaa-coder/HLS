// middleware.js (racine du projet Vercel), tout-en-un : pas besoin de dossier api/.
// Publics : les liens embed (e=1 + lien s=...), /api/view (compteur de vues) et /api/live (spectateurs en direct).
// /api/meta (GET) est public : le lecteur y lit l'intro / le générique / le titre enregistrés dans la bibliothèque.
// /api/folder (GET) est public : le lecteur y lit la liste des épisodes d'un dossier. /api/report (POST) est public : bouton "Signaler un problème".
// Protégés par SITE_PASSWORD : la page d'accueil, /stats.html, /library.html, /api/stats, /api/library et l'écriture sur /api/meta, /api/reports (lecture des signalements).
export const config = { matcher: ['/', '/index.html', '/stats.html', '/stats', '/api/stats', '/api/view', '/api/live', '/api/meta', '/api/library', '/library.html', '/library', '/api/folder', '/api/report', '/api/reports', '/api/backup', '/api/health'] };

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// ---------- stockage ----------
// Au choix (variables d'environnement Vercel) :
//  - Turso (SQLite, gratuit) : TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  -> les commandes Redis ci-dessous sont traduites en SQL
//  - Upstash Redis (ancien mode) : KV_REST_API_URL + KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_*)
// Le reste du code ne change pas : il appelle toujours redis([[ 'HGET', ... ], ...]).
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS h(k TEXT NOT NULL, f TEXT NOT NULL, v TEXT, PRIMARY KEY(k,f)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS s(k TEXT NOT NULL, m TEXT NOT NULL, PRIMARY KEY(k,m)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS z(k TEXT NOT NULL, m TEXT NOT NULL, sc REAL NOT NULL, PRIMARY KEY(k,m)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS z_sc ON z(k,sc)',
  'CREATE TABLE IF NOT EXISTS u(k TEXT NOT NULL, m TEXT NOT NULL, PRIMARY KEY(k,m)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS l(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, v TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS l_k ON l(k,id)',
  'CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, v TEXT, at INTEGER) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS x(k TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID',
];
const TXT = v => ({ type: 'text', value: String(v) });
const INT = v => ({ type: 'integer', value: String(Math.trunc(+v)) });
const FLT = v => ({ type: 'float', value: +v });
const dv = x => (!x || x.type === 'null' ? null : x.type === 'integer' ? Number(x.value) : x.value);
const ph = n => Array(n).fill('?').join(',');
const rows = r => (r.rows || []).map(row => row.map(dv));
const aff = r => r.affected_row_count || 0;
const bound = (x, inf) => { const s = String(x).toLowerCase(); return s === '-inf' ? -1e300 : s === '+inf' || s === 'inf' ? 1e300 : +s || (inf ? 0 : 0); };
const ZT = ['h', 's', 'z', 'u'];

// Une commande Redis -> { st: [[sql, args], ...], out(résultats) } ; out reçoit le résultat de la dernière requête
function compile(c) {
  const op = String(c[0]).toUpperCase(), k = c[1] == null ? '' : String(c[1]);
  switch (op) {
    case 'HGET': return { st: [['SELECT v FROM h WHERE k=? AND f=?', [TXT(k), TXT(c[2])]]], out: r => (rows(r)[0] || [null])[0] };
    case 'HMGET': { const fs = c.slice(2).map(String); if (!fs.length) return { st: [['SELECT 1', []]], out: () => [] };
      return { st: [[`SELECT f,v FROM h WHERE k=? AND f IN (${ph(fs.length)})`, [TXT(k), ...fs.map(TXT)]]], out: r => { const m = new Map(rows(r)); return fs.map(f => (m.has(f) ? m.get(f) : null)); } }; }
    case 'HGETALL': return { st: [['SELECT f,v FROM h WHERE k=?', [TXT(k)]]], out: r => rows(r).flat() };
    case 'HSET': { const st = []; for (let i = 2; i + 1 < c.length; i += 2) st.push(['INSERT INTO h(k,f,v) VALUES(?,?,?) ON CONFLICT(k,f) DO UPDATE SET v=excluded.v', [TXT(k), TXT(c[i]), TXT(c[i + 1])]]);
      return { st, out: () => st.length }; }
    case 'HSETNX': return { st: [['INSERT OR IGNORE INTO h(k,f,v) VALUES(?,?,?)', [TXT(k), TXT(c[2]), TXT(c[3])]]], out: r => aff(r) };
    case 'HINCRBY': return { st: [
      ['INSERT INTO h(k,f,v) VALUES(?,?,?) ON CONFLICT(k,f) DO UPDATE SET v=CAST(CAST(h.v AS INTEGER)+? AS TEXT)', [TXT(k), TXT(c[2]), TXT(Math.trunc(+c[3])), INT(c[3])]],
      ['SELECT v FROM h WHERE k=? AND f=?', [TXT(k), TXT(c[2])]]], out: r => +(rows(r)[0] || [0])[0] };
    case 'HDEL': { const fs = c.slice(2).map(String); return { st: [[`DELETE FROM h WHERE k=? AND f IN (${ph(fs.length)})`, [TXT(k), ...fs.map(TXT)]]], out: r => aff(r) }; }
    case 'HEXISTS': return { st: [['SELECT 1 FROM h WHERE k=? AND f=?', [TXT(k), TXT(c[2])]]], out: r => ((r.rows || []).length ? 1 : 0) };
    case 'SADD': { const ms = c.slice(2).map(String); return { st: ms.map(m => ['INSERT OR IGNORE INTO s(k,m) VALUES(?,?)', [TXT(k), TXT(m)]]), out: () => ms.length }; }
    case 'SREM': { const ms = c.slice(2).map(String); return { st: [[`DELETE FROM s WHERE k=? AND m IN (${ph(ms.length)})`, [TXT(k), ...ms.map(TXT)]]], out: r => aff(r) }; }
    case 'SMEMBERS': return { st: [['SELECT m FROM s WHERE k=?', [TXT(k)]]], out: r => rows(r).map(x => x[0]) };
    case 'PFADD': { const ms = c.slice(2).map(String); return { st: ms.map(m => ['INSERT OR IGNORE INTO u(k,m) VALUES(?,?)', [TXT(k), TXT(m)]]), out: () => 1 }; }
    case 'PFCOUNT': return { st: [['SELECT COUNT(*) FROM u WHERE k=?', [TXT(k)]]], out: r => +(rows(r)[0] || [0])[0] };
    case 'ZADD': { const st = []; for (let i = 2; i + 1 < c.length; i += 2) st.push(['INSERT INTO z(k,m,sc) VALUES(?,?,?) ON CONFLICT(k,m) DO UPDATE SET sc=excluded.sc', [TXT(k), TXT(c[i + 1]), FLT(c[i])]]);
      return { st, out: () => st.length }; }
    case 'ZREM': { const ms = c.slice(2).map(String); return { st: [[`DELETE FROM z WHERE k=? AND m IN (${ph(ms.length)})`, [TXT(k), ...ms.map(TXT)]]], out: r => aff(r) }; }
    case 'ZREMRANGEBYSCORE': return { st: [['DELETE FROM z WHERE k=? AND sc>=? AND sc<=?', [TXT(k), FLT(bound(c[2])), FLT(bound(c[3]))]]], out: r => aff(r) };
    case 'ZRANGE': case 'ZREVRANGE': {
      const a = Math.max(0, parseInt(c[2], 10) || 0), b = parseInt(c[3], 10), lim = b < 0 ? -1 : Math.max(0, b - a + 1), ws = c.slice(4).some(x => String(x).toUpperCase() === 'WITHSCORES');
      const ord = op === 'ZRANGE' ? 'ASC' : 'DESC';
      return { st: [[`SELECT m,sc FROM z WHERE k=? ORDER BY sc ${ord}, m ${ord} LIMIT ? OFFSET ?`, [TXT(k), INT(lim), INT(a)]]],
        out: r => rows(r).flatMap(([m, sc]) => (ws ? [m, String(sc)] : [m])) }; }
    case 'LPUSH': return { st: c.slice(2).map(v => ['INSERT INTO l(k,v) VALUES(?,?)', [TXT(k), TXT(v)]]), out: () => 1 };
    case 'LTRIM': { const n = Math.max(0, (parseInt(c[3], 10) || 0) + 1);
      return { st: [['DELETE FROM l WHERE k=? AND id NOT IN (SELECT id FROM l WHERE k=? ORDER BY id DESC LIMIT ?)', [TXT(k), TXT(k), INT(n)]]], out: () => 'OK' }; }
    case 'LRANGE': { const b = parseInt(c[3], 10), lim = b < 0 ? -1 : (b - (parseInt(c[2], 10) || 0) + 1), off = parseInt(c[2], 10) || 0;
      return { st: [['SELECT v FROM l WHERE k=? ORDER BY id DESC LIMIT ? OFFSET ?', [TXT(k), INT(lim), INT(off)]]], out: r => rows(r).map(x => x[0]) }; }
    case 'LREM': return { st: [['DELETE FROM l WHERE id IN (SELECT id FROM l WHERE k=? AND v=? ORDER BY id DESC LIMIT ?)', [TXT(k), TXT(c[3]), INT(Math.abs(+c[2]) || 1e9)]]], out: r => aff(r) };
    case 'DEL': { const ks = c.slice(1).map(String); const st = [];
      ks.forEach(x => ['h', 's', 'z', 'u', 'l', 't', 'x'].forEach(t => st.push([`DELETE FROM ${t} WHERE k=?`, [TXT(x)]]))); return { st, out: () => ks.length }; }
    case 'SET': { const rest = c.slice(3).map(x => String(x).toUpperCase()), nx = rest.includes('NX'), ei = rest.indexOf('EX'), ex = ei >= 0 ? +c[3 + ei + 1] : 0, at = ex ? Date.now() + ex * 1000 : 9e15;
      return { st: [['DELETE FROM t WHERE k=? AND at<?', [TXT(k), INT(Date.now())]],
        [nx ? 'INSERT OR IGNORE INTO t(k,v,at) VALUES(?,?,?)' : 'INSERT OR REPLACE INTO t(k,v,at) VALUES(?,?,?)', [TXT(k), TXT(c[2]), INT(at)]]], out: r => (aff(r) ? 'OK' : null) }; }
    case 'EXPIRE': return { st: [['INSERT INTO x(k,at) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET at=excluded.at', [TXT(k), INT(Date.now() + (+c[2]) * 1000)]]], out: () => 1 };
    case 'RENAME': { const b = String(c[2]), st = [];
      ZT.forEach(t => { st.push([`DELETE FROM ${t} WHERE k=? AND EXISTS(SELECT 1 FROM ${t} WHERE k=?)`, [TXT(b), TXT(k)]], [`UPDATE ${t} SET k=? WHERE k=?`, [TXT(b), TXT(k)]]); });
      st.push(['DELETE FROM x WHERE k=? AND EXISTS(SELECT 1 FROM x WHERE k=?)', [TXT(b), TXT(k)]], ['UPDATE x SET k=? WHERE k=?', [TXT(b), TXT(k)]]);
      return { st, out: () => 'OK' }; }
    case 'ECHO': return { st: [['SELECT 1', []]], out: () => String(c[1]) };
    default: throw new Error('Commande non gérée : ' + op);
  }
}

let ready = false;
async function turso(cmds) {
  const url = String(process.env.TURSO_DATABASE_URL).replace(/^libsql:/i, 'https:').replace(/\/+$/, '');
  const reqs = [], spans = [];
  if (!ready) SCHEMA.forEach(sql => reqs.push({ type: 'execute', stmt: { sql } }));
  const first = reqs.length;
  cmds.forEach(c => { const o = compile(c); const a = reqs.length; o.st.forEach(([sql, args]) => reqs.push({ type: 'execute', stmt: { sql, args } })); spans.push({ o, last: reqs.length - 1, a, c }); });
  if (Math.random() < 0.02) { // ménage des clés expirées (EXPIRE), de temps en temps
    const n = Date.now();
    ['h', 's', 'z', 'u'].forEach(t => reqs.push({ type: 'execute', stmt: { sql: `DELETE FROM ${t} WHERE k IN (SELECT k FROM x WHERE at<?)`, args: [INT(n)] } }));
    reqs.push({ type: 'execute', stmt: { sql: 'DELETE FROM x WHERE at<?', args: [INT(n)] } }, { type: 'execute', stmt: { sql: 'DELETE FROM t WHERE at<?', args: [INT(n)] } });
  }
  reqs.push({ type: 'close' });
  const r = await fetch(url + '/v2/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }),
  });
  if (!r.ok) throw new Error('Turso ' + r.status);
  const res = (await r.json()).results || [];
  for (let i = 0; i < res.length; i++) if (res[i].type === 'error') throw new Error('Turso : ' + (res[i].error && res[i].error.message));
  ready = true;
  return spans.map(s => s.o.out((res[s.last] && res[s.last].response && res[s.last].response.result) || {}));
}

async function redis(cmds) {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) return turso(cmds);
  const url =
    process.env.UPSTASH_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.UPSTASH_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Base de données non configurée (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN manquants)');
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('Redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const toObj = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };

// Pays du spectateur : en-tête fourni par Vercel (code ISO à 2 lettres). 'XX' = inconnu.
const ctry = r => {
  const c = String(r.headers.get('x-vercel-ip-country') || r.headers.get('cf-ipcountry') || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : 'XX';
};

const day = () => new Date().toISOString().slice(0, 10);
const addSecs = (src, sec, ex) => {
  const d = day();
  return [['HINCRBY', 'secs', src, sec], ['HINCRBY', 'dsecs:' + d, src, sec], ...(ex ? [['EXPIRE', 'dsecs:' + d, 3456000]] : [])];
};

async function view(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const cc = ctry(request);
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
      ['HINCRBY', 'cv:' + src, cc, 1],
      ['HINCRBY', 'cv:all', cc, 1],
    ]);
    return new Response(null, { status: 204 });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}

// Spectateurs en direct : chaque lecteur envoie un "heartbeat" toutes les ~15 s pendant la lecture.
// Un spectateur est compté "en direct" s'il a émis un heartbeat dans les LIVE_TTL dernières ms.
const LIVE_TTL = 75000; // heartbeat toutes les 30 s
async function live(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const cc = ctry(request);
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
  const ex = Math.random() < 0.1; // les EXPIRE n'ont besoin d'être rafraîchis qu'une fois de temps en temps (économise des commandes Redis)
  const sess = sec && /^[\w-]{4,40}$/.test(sid) ? [
    ['HINCRBY', 'sv:' + src, sid, sec],
    ['HSETNX', 'ss:' + src, sid, Date.now() - sec * 1000],
    ['HSETNX', 'sw:' + src, sid, vid.slice(0, 6)],
    ['HSETNX', 'sc:' + src, sid, cc],
    ['ZADD', 'sl:' + src, Date.now(), sid],
    ...(ex ? [['EXPIRE', 'sv:' + src, TTL], ['EXPIRE', 'ss:' + src, TTL], ['EXPIRE', 'sw:' + src, TTL], ['EXPIRE', 'sc:' + src, TTL], ['EXPIRE', 'sl:' + src, TTL]] : []),
  ] : [];
  const extra = sec ? [...addSecs(src, sec, ex), ...sess] : [];
  try {
    if (b.leave) await redis([['ZREM', 'live', member], ...extra]);
    else await redis([
      ['ZADD', 'live', Date.now(), member],
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
      ['uniq:', 'sv:', 'ss:', 'sw:', 'sc:', 'sl:', 'cv:'].forEach(k => rc.push(['RENAME', k + old, k + ns]));
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
        if (typeof x.mainLabel === 'string') { const l = cleanF(x.mainLabel); if (l) m.ml = l; else delete m.ml; } // nom de la qualité du lien principal
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

const KINDS = ['Pas de son', 'Sous-titres', 'Image qui saccade', 'Qualité', 'Ne démarre pas', 'Mauvais épisode', 'Autre', 'Erreur auto'];
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
    const auto = kind === 'Erreur auto'; // erreur détectée par le lecteur (pas de clic de l'utilisateur) : limite séparée
    const [ok] = await redis([['SET', (auto ? 'rla:' : 'rl:') + vid, 1, 'NX', 'EX', auto ? 20 : 15]]);
    if (!ok) return json({ error: 'Trop de signalements, réessaie dans quelques secondes.' }, 429);
    const r = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), src,
      title: String(b.title || '').slice(0, 200), kind, msg,
      pos: Math.max(0, Math.round(+b.pos || 0)), who: vid.slice(0, 6), ua: String(request.headers.get('user-agent') || '').slice(0, 140),
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
    // Erreurs auto : le spectateur a-t-il pu regarder ensuite ? (session de lecture du même \"who\" qui continue > 10 s après l'erreur)
    try {
      const autos = items.filter(x => x.kind === 'Erreur auto' && x.who);
      const srcs = [...new Set(autos.map(x => x.src))].slice(0, 25);
      if (srcs.length) {
        const sl = await redis(srcs.map(sr => ['ZREVRANGE', 'sl:' + sr, 0, 199, 'WITHSCORES']));
        const per = srcs.map((sr, i) => { const ids = [], lasts = []; const z = sl[i] || []; for (let k = 0; k < z.length; k += 2) { ids.push(z[k]); lasts.push(+z[k + 1]); } return { ids, lasts }; });
        const det = await redis(srcs.flatMap((sr, i) => per[i].ids.length ? [['HMGET', 'sw:' + sr, ...per[i].ids], ['HMGET', 'sv:' + sr, ...per[i].ids]] : [['ECHO', 'x'], ['ECHO', 'x']]));
        const ses = {};
        srcs.forEach((sr, i) => { const w = det[i * 2], v = det[i * 2 + 1]; ses[sr] = per[i].ids.map((id, k) => ({ who: Array.isArray(w) ? w[k] : '', secs: Array.isArray(v) ? +v[k] || 0 : 0, last: per[i].lasts[k] })); });
        autos.forEach(x => {
          const mine = (ses[x.src] || []).filter(q => q.who === x.who && q.last > x.t + 10000);
          x.fix = mine.length ? { ok: true, secs: Math.round(mine.reduce((a, q) => a + q.secs, 0)) } : { ok: false };
          x.rep = autos.filter(y => y.who === x.who && y.src === x.src).length; // même spectateur, même vidéo : nombre d'erreurs
        });
      }
    } catch (e) {}
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
        src: s, title: m.t || titles[s] || '', folder: m.f || '', subs: m.c || [], quals: m.q || [], mainLabel: m.ml || '', intro: m.i === undefined ? null : m.i, outro: m.o === undefined ? null : m.o,
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
      cmds.push(['HGETALL', 'cv:' + only]);
      cmds.push(['ZREVRANGE', 'sl:' + only, 0, 99, 'WITHSCORES']);
      const r = await redis(cmds);
      const sl = r[r.length - 1] || [], countries = toObj(r[r.length - 2]), ids = [], lasts = [];
      for (let i = 0; i < sl.length; i += 2) { ids.push(sl[i]); lasts.push(+sl[i + 1]); }
      let sessions = [];
      if (ids.length) {
        const [sv, ss, sw, sc] = await redis([['HMGET', 'sv:' + only, ...ids], ['HMGET', 'ss:' + only, ...ids], ['HMGET', 'sw:' + only, ...ids], ['HMGET', 'sc:' + only, ...ids]]);
        sessions = ids.map((id, i) => ({ id, secs: +sv[i] || 0, start: +ss[i] || 0, last: lasts[i], who: sw[i] || '', c: sc[i] || '' }));
      }
      return json({ days: days.map((d, i) => ({ d, secs: +r[i * 2] || 0, views: +r[i * 2 + 1] || 0 })).reverse(), sessions, countries });
    }
    const now = Date.now();
    const [, plays, titles, last, liveRaw, secs, countries] = (await redis([
      ['ZREMRANGEBYSCORE', 'live', '-inf', now - LIVE_TTL],
      ['HGETALL', 'plays'], ['HGETALL', 'titles'], ['HGETALL', 'last'],
      ['ZRANGE', 'live', 0, -1], ['HGETALL', 'secs'], ['HGETALL', 'cv:all'],
    ])).map((x, i) => ((i >= 1 && i <= 3) || i === 5 || i === 6 ? toObj(x) : x));
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
    return json({ videos, liveTotal, countries });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}


// Sauvegarde / restauration de la bibliothèque (réglages, vues, titres) : un fichier JSON, utilisable avec n'importe quelle base.
const BK = ['meta', 'plays', 'titles', 'last', 'secs'];
async function backup(request) {
  try {
    if (request.method === 'POST') {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      const d = b && b.data;
      if (!d || typeof d !== 'object') return json({ error: 'Fichier invalide.' }, 400);
      const cmds = [];
      BK.forEach(h => {
        const o = d[h];
        if (!o || typeof o !== 'object') return;
        const ents = Object.entries(o).filter(([s]) => okSrc(s));
        for (let i = 0; i < ents.length; i += 100) cmds.push(['HSET', h, ...ents.slice(i, i + 100).flat().map(String)]);
      });
      Object.entries(d.meta || {}).forEach(([s, raw]) => { try { const f = JSON.parse(raw).f; if (f && okSrc(s)) cmds.push(['SADD', fkey(f), s]); } catch (e) {} });
      for (let i = 0; i < cmds.length; i += 200) await redis(cmds.slice(i, i + 200));
      return json({ ok: true, n: Object.keys(d.meta || {}).length });
    }
    const r = (await redis(BK.map(h => ['HGETALL', h]))).map(toObj);
    const data = {};
    BK.forEach((h, i) => { data[h] = r[i]; });
    return new Response(JSON.stringify({ app: 'flux', v: 1, t: Date.now(), data }), {
      headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="flux-sauvegarde-' + day() + '.json"', 'cache-control': 'no-store' },
    });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
}


// Diagnostic : quel stockage est utilisé, et répond-il ?
async function health() {
  const mode = process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN ? 'Turso'
    : (process.env.UPSTASH_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) ? 'Upstash (ancien mode)' : 'aucun';
  const t = Date.now();
  try { await redis([['ECHO', 'ok']]); return json({ mode, ok: true, ms: Date.now() - t }); }
  catch (e) { return json({ mode, ok: false, error: String(e.message || e) }); }
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
  if (u.pathname === '/api/backup') return backup(request);
  if (u.pathname === '/api/health') return health();
  if (u.pathname === '/api/meta') return metaPost(request);
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
