// POST /api/view  { src, title, vid }  -> enregistre une vue
const { pipeline } = require('./_redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const src = String(b.src || '').slice(0, 1500);
  const title = String(b.title || '').slice(0, 200);
  const vid = String(b.vid || '').slice(0, 80);
  if (!/^https?:\/\//i.test(src) || !vid) return res.status(400).end();
  try {
    await pipeline([
      ['HINCRBY', 'plays', src, 1],
      ['PFADD', 'uniq:' + src, vid],
      ['HSET', 'titles', src, title],
      ['HSET', 'last', src, Date.now()],
    ]);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
