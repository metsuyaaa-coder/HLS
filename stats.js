// GET /api/stats -> liste des vidéos avec vues et spectateurs uniques (protégé par le middleware)
const { pipeline, toObj } = require('./_redis');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [plays, titles, last] = (await pipeline([['HGETALL', 'plays'], ['HGETALL', 'titles'], ['HGETALL', 'last']])).map(toObj);
    const srcs = Object.keys(plays);
    const uniq = srcs.length ? await pipeline(srcs.map(s => ['PFCOUNT', 'uniq:' + s])) : [];
    const videos = srcs.map((s, i) => ({
      src: s,
      title: titles[s] || '',
      plays: +plays[s] || 0,
      viewers: uniq[i] || 0,
      last: +last[s] || 0,
    })).sort((a, b) => b.plays - a.plays);
    res.status(200).json({ videos });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
