/**
 * vos.chat/{page_slug} — la página pública de cada negocio, renderizada en el
 * servidor (Vercel serverless). HTML real: Google ve el contenido, no una
 * cáscara que se llena con JavaScript.
 *
 * Datos: GET {ENGINE}/api/public/page/:pageSlug (vos-app). El 404 del motor
 * (inexistente / no publicada / slug inválido, indistinguibles a propósito) se
 * traduce acá a un 404 real con una página genérica que tampoco revela nada.
 *
 * REGLA DURA: nunca se inventa un dato. Cada bloque se renderiza SOLO si el
 * motor lo devolvió — sin huecos, sin "sin dirección". Y si el motor está
 * caído, esta página falla sola: el resto de vos.chat es estático y ni se
 * entera.
 *
 * Caché en dos capas (argumento en el PR):
 *   1. CDN de Vercel: s-maxage=300 + stale-while-revalidate=600 — la mayoría
 *      de las visitas ni llegan a esta función.
 *   2. Memoria del proceso (por instancia caliente): TTL 5 min, y las entradas
 *      viejas (hasta 24 h) sirven de red de emergencia si el motor no responde
 *      — mejor una página de hace una hora que un error.
 */

const ENGINE = process.env.VOS_ENGINE_URL || 'https://vos-hnqb.onrender.com';
const TTL_OK_MS = 5 * 60 * 1000;        // frescura normal
const TTL_MISS_MS = 60 * 1000;          // 404: reintentar pronto (quizá publicó recién)
const STALE_RESCUE_MS = 24 * 60 * 60 * 1000; // hasta dónde sirve una copia vieja si el motor cayó
const FETCH_TIMEOUT_MS = 5000;

const cache = new Map(); // slug -> { at, status, page, publishedAt }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='9' fill='%2326201c'/%3E%3Cpath d='M20 8c7.2 0 13 4.5 13 10.1 0 5.6-5.8 10-13 10-1.6 0-3.2-.2-4.6-.6L8 31l1.7-5.2C7.7 24.1 6 21.4 6 18.1 6 12.5 12.8 8 20 8Z' fill='%23c8993c'/%3E%3Ccircle cx='14.4' cy='18.3' r='2.1' fill='%2326201c'/%3E%3Ccircle cx='20' cy='18.3' r='2.1' fill='%2326201c'/%3E%3Ccircle cx='25.6' cy='18.3' r='2.1' fill='%2326201c'/%3E%3C/svg%3E";

// Misma identidad que index.html: fondo cálido oscuro, dorado, Fraunces para
// los títulos, Hanken Grotesk para el cuerpo. Teléfono primero: una columna,
// CTA de WhatsApp fija abajo, tipografías fluidas.
const BASE_CSS = `
:root{--ink:#26201c;--gold:#c8993c;--bone:#f6f0e6;--camel:#d8b98a;--clay:#b6764a;--paper:#f3ead9}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:'Hanken Grotesk',system-ui,sans-serif;background:#1b1611;color:var(--bone);-webkit-font-smoothing:antialiased;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:34px 22px 120px}
h1{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:clamp(30px,8vw,42px);line-height:1.08;margin:10px 0 0;color:var(--bone)}
.rubro{font-weight:600;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--camel);margin:14px 0 0}
.sec{margin-top:34px}
.sec h2{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:20px;color:var(--camel);margin:0 0 12px}
.cat{list-style:none;margin:0;padding:0}
.cat li{display:flex;justify-content:space-between;gap:14px;align-items:baseline;padding:11px 0;border-bottom:1px solid rgba(216,185,138,.16);font-size:16px}
.cat li:last-child{border-bottom:none}
.cat .p{font-weight:700;color:var(--gold);white-space:nowrap}
.info p{margin:0 0 10px;font-size:15.5px;line-height:1.55;opacity:.92}
.info a{color:var(--camel)}
.wa-bar{position:fixed;left:0;right:0;bottom:0;padding:14px 22px calc(14px + env(safe-area-inset-bottom));background:linear-gradient(transparent,rgba(27,22,17,.86) 34%,#1b1611 78%)}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:10px;max-width:516px;margin:0 auto;height:56px;border-radius:16px;background:var(--gold);color:var(--ink);font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 10px 30px rgba(200,153,60,.35)}
.wa-btn svg{flex:none}
.foot{margin-top:44px;font-size:12.5px;opacity:.55}
.foot a{color:var(--camel);text-decoration:none}
`;

function head({ title, description, url, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${FAVICON}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="vos.chat">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${url ? `<meta property="og:url" content="${esc(url)}">\n<link rel="canonical" href="${esc(url)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap" rel="stylesheet">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ''}
<style>${BASE_CSS}</style>
</head>`;
}

const WA_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3c5 0 9 3.6 9 8s-4 8-9 8c-1.1 0-2.2-.16-3.2-.46L4 20l1.2-3.7C3.8 15 3 13.6 3 11c0-4.4 4-8 9-8Z" fill="#26201c"/></svg>`;

/** Descripción SOLO con datos reales presentes, para <meta> y OG. */
function buildDescription(page) {
  const bits = [];
  if (page.category) bits.push(page.category);
  if (page.contact?.address) bits.push(page.contact.address);
  bits.push('Escribinos por WhatsApp y te contestamos al toque.');
  return bits.join(' · ');
}

/** JSON-LD LocalBusiness — solo campos que mapean limpio; nada inventado ni
 * forzado (los horarios son texto libre del negocio: no se disfrazan de
 * openingHoursSpecification, y los precios son strings: no van al schema). */
function buildJsonLd(page, url) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: page.name,
    url,
  };
  if (page.contact?.phone) ld.telephone = page.contact.phone;
  if (page.contact?.address) ld.address = { '@type': 'PostalAddress', streetAddress: page.contact.address };
  const sameAs = [];
  if (page.contact?.website) sameAs.push(page.contact.website);
  if (page.contact?.maps_uri) sameAs.push(page.contact.maps_uri);
  if (sameAs.length) ld.sameAs = sameAs;
  if (Array.isArray(page.catalog) && page.catalog.length) {
    ld.makesOffer = page.catalog.slice(0, 20).map((p) => ({ '@type': 'Offer', itemOffered: { '@type': 'Product', name: p.name } }));
  }
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

function renderBusiness(page, url) {
  const c = page.contact || {};
  const infoRows = [];
  if (c.address) infoRows.push(`<p>${esc(c.address)}${c.maps_uri ? ` · <a href="${esc(c.maps_uri)}" rel="noopener">Cómo llegar</a>` : ''}</p>`);
  if (Array.isArray(c.hours)) for (const h of c.hours) infoRows.push(`<p>${esc(h)}</p>`);
  if (c.phone) infoRows.push(`<p><a href="tel:${esc(String(c.phone).replace(/[^+\d]/g, ''))}">${esc(c.phone)}</a></p>`);
  if (c.website) infoRows.push(`<p><a href="${esc(c.website)}" rel="noopener">${esc(String(c.website).replace(/^https?:\/\//, ''))}</a></p>`);
  if (c.instagram) infoRows.push(`<p><a href="https://instagram.com/${esc(String(c.instagram).replace(/^@/, ''))}" rel="noopener">${esc(c.instagram)}</a></p>`);

  const catalogRows = (Array.isArray(page.catalog) ? page.catalog : [])
    .map((p) => `<li><span>${esc(p.name)}</span>${p.price ? `<span class="p">${esc(p.price)}</span>` : ''}</li>`)
    .join('');

  return `${head({ title: `${page.name} · WhatsApp`, description: buildDescription(page), url, jsonLd: buildJsonLd(page, url) })}
<body>
<main class="wrap">
  ${page.category ? `<p class="rubro">${esc(page.category)}</p>` : ''}
  <h1>${esc(page.name)}</h1>
  ${catalogRows ? `<section class="sec"><h2>Qué ofrecemos</h2><ul class="cat">${catalogRows}</ul></section>` : ''}
  ${infoRows.length ? `<section class="sec info"><h2>Dónde y cuándo</h2>${infoRows.join('')}</section>` : ''}
  <p class="foot">Atendemos por WhatsApp con <a href="https://vos.chat" rel="noopener">VOS</a>.</p>
</main>
${page.wa_link ? `<div class="wa-bar"><a class="wa-btn" href="${esc(page.wa_link)}" rel="noopener">${WA_ICON}Escribinos por WhatsApp</a></div>` : ''}
</body>
</html>`;
}

function renderNotFound() {
  return `${head({ title: 'Página no encontrada · vos.chat', description: 'Esta dirección no corresponde a ninguna página publicada.' })}
<body>
<main class="wrap">
  <h1>Acá no hay nada</h1>
  <section class="sec info">
    <p>Esta dirección no corresponde a ninguna página publicada en vos.chat.</p>
    <p>Si te pasaron este link, pedile al negocio que lo revise — y si el negocio sos vos, publicá tu página desde tu panel.</p>
    <p><a href="https://vos.chat">← Volver a vos.chat</a></p>
  </section>
</main>
</body>
</html>`;
}

function renderUnavailable() {
  return `${head({ title: 'Un momento · vos.chat', description: 'La página no está disponible en este instante.' })}
<body>
<main class="wrap">
  <h1>Un momento…</h1>
  <section class="sec info">
    <p>No pudimos cargar esta página justo ahora. Probá de nuevo en un ratito — el negocio sigue atendiendo por WhatsApp.</p>
  </section>
</main>
</body>
</html>`;
}

async function fetchPage(slug) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${ENGINE}/api/public/page/${encodeURIComponent(slug)}`, { signal: ctrl.signal });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) throw new Error(`engine ${r.status}`);
    const body = await r.json();
    if (!body?.ok || !body.page) return { status: 404 };
    return { status: 200, page: body.page, publishedAt: body.published_at ?? null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.slug) || '').toLowerCase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Slug inválido ≡ inexistente, misma página, sin tocar el motor.
  if (!/^[a-z0-9-]{3,60}$/.test(raw)) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(404).send(renderNotFound());
  }

  const url = `https://vos.chat/${raw}`;
  const now = Date.now();
  const cached = cache.get(raw);

  // Frescura en memoria (instancia caliente): ni motor ni CDN.
  if (cached && now - cached.at < (cached.status === 200 ? TTL_OK_MS : TTL_MISS_MS)) {
    res.setHeader('Cache-Control', cached.status === 200 ? 'public, s-maxage=300, stale-while-revalidate=600' : 'public, s-maxage=60');
    return res.status(cached.status).send(cached.status === 200 ? renderBusiness(cached.page, url) : renderNotFound());
  }

  try {
    const r = await fetchPage(raw);
    cache.set(raw, { at: now, ...r });
    if (r.status === 200) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).send(renderBusiness(r.page, url));
    }
    // 404 con caché corta: si el negocio publica recién, lo ve en ~1 min.
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(404).send(renderNotFound());
  } catch {
    // Motor caído o lento. Copia vieja (hasta 24 h) antes que un error: los
    // datos de un negocio cambian poco y el link lo abre un cliente final.
    if (cached && cached.status === 200 && now - cached.at < STALE_RESCUE_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(200).send(renderBusiness(cached.page, url));
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send(renderUnavailable());
  }
};
