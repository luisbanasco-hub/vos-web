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

const { createHash } = require('node:crypto');

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

// ── Esquemas permitidos en un href (M-03) ────────────────────────────────────
//
// `esc()` impide ROMPER el atributo, pero no impide que el valor entero sea
// `javascript:...`. Un dueño que escribe eso en el campo de sitio web publica en
// vos.chat un link que ejecuta código al hacer clic. Y no es "se ataca a sí
// mismo": todas las páginas viven bajo el MISMO origen, vos.chat/{slug}, así que
// lo que se ejecute ahí comparte origen con las demás páginas y con todo lo que
// vos.chat guarde en ese origen. Además el link se lo mandamos a SUS clientes.
//
// ALLOWLIST, NUNCA BLOCKLIST. Filtrar la cadena "javascript:" es la defensa que
// se saltea con mayúsculas, espacios, tabs o saltos de línea — medido con el
// parser nativo: `JaVaScRiPt:`, `java\nscript:` y ` javascript:` terminan los
// tres en `protocol === 'javascript:'`. Parsear y aceptar sólo esquemas conocidos
// no tiene esa clase de agujero, porque la pregunta se la contesta el mismo
// parser que después va a usar el browser.
//
// Se devuelve `parsed.href` —la serialización canónica del parser— y no la
// cadena original: lo que emitimos es exactamente lo que el parser leyó.

/** Sitio web del negocio: lo tipea una persona. Ver `http:` en el PR. */
const SCHEMES_WEBSITE = new Set(['https:', 'http:']);
/** Links que arma una máquina (motor o Google Places): no hay caso http legítimo. */
const SCHEMES_MACHINE = new Set(['https:']);
/** Sólo para el link de teléfono. */
const SCHEMES_TEL = new Set(['tel:']);

/**
 * URL absoluta y de esquema permitido, o `null`.
 *
 * `null` significa NO RENDERIZAR EL LINK — nunca un href vacío, un `#`, ni el
 * valor mostrado igual sin enlazar el href. Un valor relativo (`misitio.com.ar`)
 * tampoco pasa: `new URL()` lo rechaza, y enlazarlo apuntaría a vos.chat.
 *
 * @param {*} raw
 * @param {Set<string>} allowed esquemas aceptados, con los dos puntos incluidos
 * @returns {string|null}
 */
function safeHref(raw, allowed) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null; // no parsea como URL absoluta
  }
  if (!allowed.has(parsed.protocol)) return null;
  return parsed.href;
}

// Un handle de Instagram real es `[A-Za-z0-9._]`, hasta 30. Acá el esquema y el
// host los ponemos nosotros, así que no hay riesgo de origen — pero un valor que
// no es un handle sólo produce un link muerto, y un link muerto en la página de
// un negocio es peor que no mostrar la fila.
const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;

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

function renderBusiness(page, url, jsonLd = buildJsonLd(page, url)) {
  const c = page.contact || {};
  const infoRows = [];
  // Todo href que salga de datos del tenant pasa por safeHref(). Si no valida,
  // la fila se renderiza SIN el link (o no se renderiza), nunca con un link roto.
  const mapsHref = safeHref(c.maps_uri, SCHEMES_MACHINE);
  const websiteHref = safeHref(c.website, SCHEMES_WEBSITE);
  // El `tel:` lo componemos nosotros a partir de los dígitos del número; se
  // valida igual, y sin un solo dígito no hay link que valga.
  const telDigits = String(c.phone ?? '').replace(/[^+\d]/g, '');
  const telHref = /\d/.test(telDigits) ? safeHref(`tel:${telDigits}`, SCHEMES_TEL) : null;
  const igHandle = String(c.instagram ?? '').replace(/^@/, '');
  const igHref = INSTAGRAM_HANDLE.test(igHandle) ? `https://instagram.com/${igHandle}` : null;

  if (c.address) infoRows.push(`<p>${esc(c.address)}${mapsHref ? ` · <a href="${esc(mapsHref)}" rel="noopener">Cómo llegar</a>` : ''}</p>`);
  if (Array.isArray(c.hours)) for (const h of c.hours) infoRows.push(`<p>${esc(h)}</p>`);
  // Sin href válido el teléfono se sigue MOSTRANDO: es un dato útil por sí solo
  // y no depende de que se pueda enlazar.
  if (c.phone) infoRows.push(`<p>${telHref ? `<a href="${esc(telHref)}">${esc(c.phone)}</a>` : esc(c.phone)}</p>`);
  if (websiteHref) infoRows.push(`<p><a href="${esc(websiteHref)}" rel="noopener">${esc(String(c.website).replace(/^https?:\/\//, ''))}</a></p>`);
  if (igHref) infoRows.push(`<p><a href="${esc(igHref)}" rel="noopener">${esc(c.instagram)}</a></p>`);

  const catalogRows = (Array.isArray(page.catalog) ? page.catalog : [])
    .map((p) => `<li><span>${esc(p.name)}</span>${p.price ? `<span class="p">${esc(p.price)}</span>` : ''}</li>`)
    .join('');

  // wa_link lo ARMA EL MOTOR (`https://wa.me/${digits}` en business-page.js), no
  // sale de la fila del tenant. Se valida igual: esta capa no confía en la de
  // arriba, y si mañana ese link pasara a ser configurable el agujero ya está
  // tapado. Sin link válido no hay barra de WhatsApp — mejor sin botón que con
  // un botón que lleva a cualquier lado.
  const waHref = safeHref(page.wa_link, SCHEMES_MACHINE);

  return `${head({ title: `${page.name} · WhatsApp`, description: buildDescription(page), url, jsonLd })}
<body>
<main class="wrap">
  ${page.category ? `<p class="rubro">${esc(page.category)}</p>` : ''}
  <h1>${esc(page.name)}</h1>
  ${catalogRows ? `<section class="sec"><h2>Qué ofrecemos</h2><ul class="cat">${catalogRows}</ul></section>` : ''}
  ${infoRows.length ? `<section class="sec info"><h2>Dónde y cuándo</h2>${infoRows.join('')}</section>` : ''}
  <p class="foot">Atendemos por WhatsApp con <a href="https://vos.chat" rel="noopener">VOS</a>.</p>
</main>
${waHref ? `<div class="wa-bar"><a class="wa-btn" href="${esc(waHref)}" rel="noopener">${WA_ICON}Escribinos por WhatsApp</a></div>` : ''}
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

// ── Headers de seguridad (mitad de B-03) ─────────────────────────────────────
//
// Se ponen acá, en la respuesta de esta función, y no en `vercel.json`: eso
// alcanzaría también a index.html y a los videos, que son otra superficie y otra
// decisión. Acá el alcance es exactamente la página pública de un negocio.
//
// La CSP describe lo que la página REALMENTE usa hoy, nada más:
//   default-src 'none'  — nada está permitido salvo lo que se nombra abajo.
//   style-src           — el <style> inline con BASE_CSS, más la hoja de Google
//                         Fonts. 'unsafe-inline' y no un hash: el hash de un CSS
//                         constante se rompe en silencio con cualquier retoque
//                         de estilo, y acá no hay CSS que venga del tenant.
//   font-src            — los .woff2 de Google Fonts salen de otro host.
//   img-src data:       — el favicon es un data: URI; no hay <img> en la página
//                         (el ícono de WhatsApp es un <svg> inline).
//   script-src          — la página no corre una sola línea de JavaScript, así
//                         que 'none'. La única excepción es el HASH del bloque
//                         JSON-LD. Según la spec un `type="application/ld+json"`
//                         es un data block y ni siquiera llega al chequeo de
//                         CSP, pero los browsers no siempre coincidieron y la
//                         propia documentación de Google recomienda nonce o
//                         hash. No pude medirlo en un browser en esta máquina,
//                         y romper el structured data —la razón por la que esta
//                         función existe— se nota tarde y mal. Con el hash la
//                         pregunta desaparece: vale bajo cualquier lectura.
//                         Hash y no nonce, porque la respuesta la cachea el CDN
//                         5 minutos: un nonce compartido por miles de visitas
//                         deja de ser impredecible, un hash sigue autorizando
//                         exactamente ese contenido y nada más.
//   frame-ancestors / X-Frame-Options — que nadie la meta en un iframe para
//                         disfrazarla de otra cosa; el link se lo mandamos a los
//                         clientes del negocio.
//   base-uri / form-action 'none' — no hay <base> ni formularios, y sin esto un
//                         <base> inyectado repuntaría los links relativos.
//
// Los <a> a sitios externos son NAVEGACIÓN, no subrecurso: ninguna directiva de
// fetch los alcanza. Por eso el arreglo de los href es el que protege ahí, y la
// CSP es la segunda línea, no la primera.
function buildCsp(scriptSrc) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src data:',
    `script-src ${scriptSrc}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** CSP de las páginas sin JSON-LD (404, 503): ningún script, de ningún tipo. */
const CSP = buildCsp("'none'");

/** `'sha256-…'` del contenido EXACTO del bloque JSON-LD que se va a emitir. */
function jsonLdHash(jsonLd) {
  return `'sha256-${createHash('sha256').update(jsonLd, 'utf8').digest('base64')}'`;
}

/**
 * @param {object} res
 * @param {string|null} jsonLd contenido literal del bloque JSON-LD, si la
 *   respuesta lo lleva. Se vuelve a llamar sobre la misma `res` en el camino de
 *   la página de negocio: `setHeader` pisa el valor anterior.
 */
function setSecurityHeaders(res, jsonLd = null) {
  res.setHeader('Content-Security-Policy', jsonLd ? buildCsp(jsonLdHash(jsonLd)) : CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // La página enlaza al sitio del negocio: no hace falta contarle el path
  // completo desde el que salió el clic.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Única salida de una página de negocio. El bloque JSON-LD se construye UNA vez
 * y la misma cadena va al HTML y al hash de la CSP — si se construyera dos veces
 * bastaría un espacio de diferencia para que el hash no cierre.
 */
function sendBusiness(res, page, url, cacheControl) {
  const jsonLd = buildJsonLd(page, url);
  setSecurityHeaders(res, jsonLd);
  res.setHeader('Cache-Control', cacheControl);
  return res.status(200).send(renderBusiness(page, url, jsonLd));
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
  // En TODAS las respuestas de esta función, incluidas la de 404 y la de 503:
  // son la misma superficie HTML y el mismo origen.
  setSecurityHeaders(res);

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
    if (cached.status === 200) return sendBusiness(res, cached.page, url, 'public, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(404).send(renderNotFound());
  }

  try {
    const r = await fetchPage(raw);
    cache.set(raw, { at: now, ...r });
    if (r.status === 200) return sendBusiness(res, r.page, url, 'public, s-maxage=300, stale-while-revalidate=600');
    // 404 con caché corta: si el negocio publica recién, lo ve en ~1 min.
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(404).send(renderNotFound());
  } catch {
    // Motor caído o lento. Copia vieja (hasta 24 h) antes que un error: los
    // datos de un negocio cambian poco y el link lo abre un cliente final.
    if (cached && cached.status === 200 && now - cached.at < STALE_RESCUE_MS) {
      return sendBusiness(res, cached.page, url, 'public, s-maxage=60');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send(renderUnavailable());
  }
};

// Para `test/page.test.mjs`, que corre con node pelado. Se cuelgan como
// propiedades del handler para que `module.exports` siga siendo la función que
// Vercel espera, y para no partir el archivo en módulos que el bundler tenga que
// rastrear. No las use nadie más.
module.exports.__internals = {
  safeHref, renderBusiness, setSecurityHeaders, sendBusiness, buildJsonLd, buildCsp, jsonLdHash,
  SCHEMES_WEBSITE, SCHEMES_MACHINE, SCHEMES_TEL, CSP,
};
