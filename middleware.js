// middleware.js (à la racine du projet Vercel) : vraie protection côté serveur.
// Seules les URLs embed (e=1 + lien s=...) sont publiques. Tout le reste demande le mot de passe.
// Ajoute la variable d'environnement SITE_PASSWORD dans Vercel (Settings > Environment Variables).
export const config = { matcher: ['/', '/index.html'] };

export default function middleware(request) {
  const p = new URL(request.url).searchParams;
  const embed = (p.get('e') || p.get('embed')) === '1' && (p.get('s') || p.get('src'));
  const pass = (process.env.SITE_PASSWORD || '');
  const [scheme, enc] = (request.headers.get('authorization') || '').split(' ');
  let ok = false;
  if (scheme === 'Basic' && enc) {
    const d = atob(enc);
    ok = pass && d.slice(d.indexOf(':') + 1) === pass;
  }
  if (embed || ok) return new Response(null, { headers: { 'x-middleware-next': '1' } });
  return new Response('Accès privé', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Flux"' } });
}
