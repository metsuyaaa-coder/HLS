// middleware.js (racine du projet Vercel) : protection côté serveur.
// Publics : les liens embed (e=1 + lien s=...) et /api/view (compteur de vues).
// Protégés par SITE_PASSWORD : la page d'accueil, /stats.html et /api/stats.
export const config = { matcher: ['/', '/index.html', '/stats.html', '/stats', '/api/stats'] };

export default function middleware(request) {
  const u = new URL(request.url), p = u.searchParams;
  const home = u.pathname === '/' || u.pathname === '/index.html';
  const embed = home && (p.get('e') || p.get('embed')) === '1' && (p.get('s') || p.get('src'));
  const pass = process.env.SITE_PASSWORD || '';
  const [scheme, enc] = (request.headers.get('authorization') || '').split(' ');
  let ok = false;
  if (scheme === 'Basic' && enc) {
    const d = atob(enc);
    ok = pass && d.slice(d.indexOf(':') + 1) === pass;
  }
  if (embed || ok) return new Response(null, { headers: { 'x-middleware-next': '1' } });
  return new Response('Accès privé', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Flux"' } });
}
