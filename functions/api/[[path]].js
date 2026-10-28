// Cloudflare Pages Function: forwards /api/* to the runner on the Pi through a Cloudflare Tunnel.
// The Pi hostname is behind Cloudflare Access (service auth), so the token is added here and
// never reaches the browser. Users are kept out of this function by an Access app on the Pages site.

export async function onRequest({ request, env }) {
  const { API_ORIGIN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = env;
  if (!API_ORIGIN || !CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
    return Response.json({ error: 'Pages env vars API_ORIGIN, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set' }, { status: 500 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete('cookie'); // the user's Access cookie is for the Pages site, not the Pi
  headers.set('CF-Access-Client-Id', CF_ACCESS_CLIENT_ID);
  headers.set('CF-Access-Client-Secret', CF_ACCESS_CLIENT_SECRET);
  const res = await fetch(new URL(url.pathname + url.search, API_ORIGIN), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
  // The runner never redirects; a redirect means Access rejected the service token.
  if (res.status >= 300 && res.status < 400) {
    return Response.json({ error: 'The runner rejected the proxy (check the Access service token).' }, { status: 502 });
  }
  return res;
}
