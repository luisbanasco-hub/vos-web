/**
 * Verificación de `api/page.js` — M-03: allowlist de esquemas en los href, y los
 * headers de seguridad de la respuesta.
 *
 * El repo no tiene infraestructura de tests ni package.json: esto corre con node
 * pelado, sin dependencias y sin instalar nada.
 *
 *   node test/page.test.mjs
 *
 * Sale con código 1 si algo falla, así que sirve igual desde un hook o desde CI
 * el día que exista.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { __internals } = require(join(ROOT, 'api', 'page.js'));
const { safeHref, renderBusiness, setSecurityHeaders, sendBusiness, buildJsonLd, jsonLdHash, SCHEMES_WEBSITE, SCHEMES_MACHINE, SCHEMES_TEL, CSP } = __internals;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(label) {
  console.log('');
  console.log('═'.repeat(70));
  console.log(`  ${label}`);
  console.log('═'.repeat(70));
}

const URL_BASE = 'https://vos.chat/mi-negocio';
const basePage = (over = {}) => ({
  name: 'Café Luna',
  category: 'Cafetería',
  wa_link: 'https://wa.me/5491155554444',
  catalog: [{ name: 'Flat white', price: '$3.500' }],
  contact: { address: 'Av. Siempreviva 742' },
  ...over,
});

/** Todos los href que la página termina emitiendo. */
function hrefsOf(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
}

// ══════════════════════════════════════════════════════════════
section('ALLOWLIST · safeHref() acepta sólo esquemas conocidos');
// ══════════════════════════════════════════════════════════════
// La familia entera de bypasses de un filtro por string: mayúsculas, espacio
// adelante, tab y salto de línea EN EL MEDIO del esquema. El parser nativo las
// normaliza todas a `javascript:` — por eso preguntarle a él no tiene esa clase
// de agujero, y por eso esto es allowlist y no blocklist.
const EJECUTABLES = [
  ['javascript:alert(1)', 'javascript: pelado'],
  ['JaVaScRiPt:alert(1)', 'mayúsculas mezcladas'],
  [' javascript:alert(1)', 'espacio adelante'],
  ['java\nscript:alert(1)', 'salto de línea en el medio del esquema'],
  ['jav\tascript:alert(1)', 'tab en el medio del esquema'],
  ['\u0000javascript:alert(1)', 'byte nulo adelante'],
  ['data:text/html,<script>alert(1)</script>', 'data: con HTML'],
  ['vbscript:msgbox(1)', 'vbscript:'],
  ['blob:https://vos.chat/abc', 'blob:'],
  ['file:///etc/passwd', 'file:'],
];
for (const [value, label] of EJECUTABLES) {
  check(safeHref(value, SCHEMES_WEBSITE) === null, `${label} → descartado`);
}

const NO_URL = [
  ['misitio.com.ar', 'sin esquema (sería un link relativo a vos.chat)'],
  ['//evil.com', 'protocol-relative'],
  ['/otro-negocio', 'path relativo'],
  ['', 'vacío'],
  ['   ', 'sólo espacios'],
  [null, 'null'],
  [undefined, 'undefined'],
  [{ toString: () => 'https://a.com' }, 'objeto (no string)'],
  [12345, 'número'],
];
for (const [value, label] of NO_URL) {
  check(safeHref(value, SCHEMES_WEBSITE) === null, `${label} → descartado`);
}

check(safeHref('https://misitio.com.ar', SCHEMES_WEBSITE) === 'https://misitio.com.ar/', 'https normal → aceptado');
check(safeHref('http://misitio.com.ar', SCHEMES_WEBSITE) === 'http://misitio.com.ar/', 'http aceptado SOLO para el sitio que tipea el dueño');
check(safeHref('http://misitio.com.ar', SCHEMES_MACHINE) === null, 'http rechazado en los links que arma una máquina');
check(safeHref('https://maps.google.com/?cid=1', SCHEMES_MACHINE) === 'https://maps.google.com/?cid=1', 'https aceptado para maps/wa_link');
check(safeHref('tel:+5491155554444', SCHEMES_TEL) === 'tel:+5491155554444', 'tel: aceptado donde corresponde');
check(safeHref('tel:+5491155554444', SCHEMES_WEBSITE) === null, 'tel: NO se cuela como sitio web');
check(safeHref('https://a.com', SCHEMES_TEL) === null, 'https NO se cuela como teléfono');
check(safeHref('HTTPS://MiSitio.com.AR/Ruta', SCHEMES_WEBSITE) === 'https://misitio.com.ar/Ruta',
  'se devuelve la serialización canónica del parser, no la cadena original');

// ══════════════════════════════════════════════════════════════
section('RENDER · un valor descartado no produce NINGÚN <a>');
// ══════════════════════════════════════════════════════════════
{
  const html = renderBusiness(basePage({ contact: { address: 'Av. Siempreviva 742', website: 'javascript:alert(document.domain)' } }), URL_BASE);
  check(!hrefsOf(html).some((h) => /javascript:/i.test(h)), 'website con javascript: → no queda NINGÚN href con ese esquema');
  check(!html.includes('<a href="javascript'), 'y no hay ningún <a> con el payload');
  check(!/href="#"/.test(html) && !/href=""/.test(html), 'tampoco se degrada a href="#" ni a href vacío');
  check(html.includes('Av. Siempreviva 742'), 'el resto de la página se renderiza igual');
}
{
  const html = renderBusiness(basePage({ contact: { address: 'Calle 1', maps_uri: 'javascript:alert(1)' } }), URL_BASE);
  check(!hrefsOf(html).some((h) => /javascript:/i.test(h)), 'maps_uri con javascript: → descartado');
  check(html.includes('Calle 1') && !html.includes('Cómo llegar'), 'la dirección se muestra, sin el link "Cómo llegar"');
}
{
  const html = renderBusiness(basePage({ wa_link: 'javascript:alert(1)' }), URL_BASE);
  check(!hrefsOf(html).some((h) => /javascript:/i.test(h)), 'wa_link con javascript: → descartado');
  check(!/<a class="wa-btn"/.test(html), 'sin link válido no hay botón de WhatsApp (mejor sin botón que con uno que lleva a cualquier lado)');
}

// ══════════════════════════════════════════════════════════════
section('RENDER · las URLs legítimas se siguen renderizando');
// ══════════════════════════════════════════════════════════════
{
  const page = basePage({
    contact: {
      address: 'Av. Siempreviva 742',
      maps_uri: 'https://maps.google.com/?cid=123',
      website: 'https://cafeluna.com.ar',
      phone: '+54 9 11 5555-4444',
      instagram: '@cafeluna',
      hours: ['Lun a Vie 8 a 20'],
    },
  });
  const html = renderBusiness(page, URL_BASE);
  const hrefs = hrefsOf(html);
  check(hrefs.includes('https://maps.google.com/?cid=123'), 'maps_uri https → link presente');
  check(hrefs.includes('https://cafeluna.com.ar/'), 'website https → link presente');
  check(hrefs.includes('tel:+5491155554444'), 'teléfono → link tel: con los dígitos');
  check(hrefs.includes('https://instagram.com/cafeluna'), 'instagram → link al handle');
  check(hrefs.includes('https://wa.me/5491155554444'), 'wa_link → botón de WhatsApp presente');
  check(html.includes('cafeluna.com.ar<'), 'el texto visible del sitio sigue sin el esquema, como antes');
  check(html.includes('Lun a Vie 8 a 20') && html.includes('Flat white'), 'horarios y catálogo intactos');
  check(hrefs.every((h) => /^(https?:|tel:)/.test(h)), 'TODOS los href de la página son de un esquema permitido');
}
{
  // http: sólo donde lo tipea una persona.
  const html = renderBusiness(basePage({ contact: { website: 'http://viejositio.com.ar' } }), URL_BASE);
  check(hrefsOf(html).includes('http://viejositio.com.ar/'), 'un sitio http del dueño se sigue enlazando');
}
{
  // Casos borde que antes producían un link muerto.
  const html = renderBusiness(basePage({ contact: { phone: 'llamanos', instagram: '@no es un handle' } }), URL_BASE);
  check(!hrefsOf(html).some((h) => h.startsWith('tel:')), 'un teléfono sin dígitos no genera href="tel:"');
  check(html.includes('llamanos'), 'pero el dato se sigue mostrando como texto');
  check(!hrefsOf(html).some((h) => h.includes('instagram.com')), 'un handle de instagram inválido no genera link muerto');
}

// ══════════════════════════════════════════════════════════════
section('HEADERS · seguridad en la respuesta');
// ══════════════════════════════════════════════════════════════
{
  const headers = {};
  setSecurityHeaders({ setHeader: (k, v) => { headers[k] = v; } });
  check(headers['X-Frame-Options'] === 'DENY', 'X-Frame-Options: DENY');
  check(headers['X-Content-Type-Options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
  check(typeof headers['Content-Security-Policy'] === 'string', 'Content-Security-Policy presente');
  check(headers['Referrer-Policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy');

  check(CSP.includes("default-src 'none'"), 'CSP arranca cerrada: default-src none');
  check(CSP.includes("script-src 'none'"), 'CSP base (404/503): script-src none — la página no corre JavaScript');
  check(CSP.includes("frame-ancestors 'none'"), 'frame-ancestors none');
  // Lo que la página REALMENTE usa hoy tiene que estar permitido, o la rompemos.
  check(CSP.includes('https://fonts.googleapis.com'), 'la hoja de Google Fonts está permitida');
  check(CSP.includes('font-src https://fonts.gstatic.com'), 'los archivos de fuente están permitidos');
  check(CSP.includes('img-src data:'), 'el favicon data: está permitido');
  check(CSP.includes("style-src 'unsafe-inline'"), 'el <style> inline está permitido');
}
{
  // La CSP tiene que cubrir cada host que la página pide de verdad.
  const html = renderBusiness(basePage(), URL_BASE);
  // Sólo los que el browser BAJA (stylesheet). `canonical` y `og:url` no son
  // subrecursos y ninguna directiva de fetch los alcanza.
  const hojas = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
    .map((m) => /href="(https:\/\/[^"]+)"/.exec(m[0])?.[1])
    .filter(Boolean)
    .map((h) => new URL(h).origin);
  check(hojas.length > 0 && hojas.every((o) => CSP.includes(o)),
    `toda hoja de estilo externa está contemplada en la CSP (${[...new Set(hojas)].join(', ')})`);
}

// ══════════════════════════════════════════════════════════════
section('CSP · el hash del JSON-LD corresponde al bloque emitido');
// ══════════════════════════════════════════════════════════════
{
  // Si el HTML y el header se construyeran por separado, bastaría un espacio de
  // diferencia para que el hash no cierre y el bloque quedara sin autorizar.
  // Esto verifica que salen de la MISMA cadena.
  const headers = {};
  let body = '';
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status() { return this; },
    send(html) { body = html; },
  };
  sendBusiness(res, basePage(), URL_BASE, 'public, s-maxage=300');

  const emitido = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body)?.[1];
  check(typeof emitido === 'string' && emitido.length > 0, 'la página emite un bloque JSON-LD');
  check(JSON.parse(emitido.replace(/\\u003c/g, '<')).name === 'Café Luna', 'y es JSON válido con los datos del negocio');
  const esperado = jsonLdHash(emitido);
  check(headers['Content-Security-Policy'].includes(`script-src ${esperado}`),
    'la CSP autoriza EXACTAMENTE ese bloque por su hash sha256');
  check(!headers['Content-Security-Policy'].includes("script-src 'none'"), 'y no quedó el script-src none del caso sin JSON-LD');
  check(!headers['Content-Security-Policy'].includes("'unsafe-inline'; script") && !/script-src[^;]*unsafe-inline/.test(headers['Content-Security-Policy']),
    'ningún unsafe-inline en script-src');
  check(headers['Cache-Control'] === 'public, s-maxage=300', 'el Cache-Control del llamador se respeta');
  check(headers['X-Frame-Options'] === 'DENY', 'los headers de seguridad también van en esta salida');
}

// ══════════════════════════════════════════════════════════════
section('JSON-LD · pasa por la MISMA allowlist que el HTML (H5)');
// ══════════════════════════════════════════════════════════════
// `sameAs` emitia `website` y `maps_uri` CRUDOS, esquivando M-03. Inerte como
// XSS, pero le entregaba a Google URLs que el propio HTML descarta por
// invalidas. La regla que se verifica es: nada en `sameAs` que no aparezca
// tambien como href de la pagina.
{
  const hostiles = {
    address: 'Av. Siempreviva 742',
    website: 'misitio.com.ar',                 // relativo: apuntaria a vos.chat
    maps_uri: 'javascript:alert(document.domain)',
  };
  const page = basePage({ contact: hostiles });
  const ld = JSON.parse(buildJsonLd(page, URL_BASE).replace(/\\u003c/g, '<'));
  check(ld.sameAs === undefined, 'website relativo + maps_uri javascript: → no queda NINGÚN sameAs');

  const html = renderBusiness(page, URL_BASE);
  check(!/javascript:/i.test(JSON.stringify(ld)), 'ningún javascript: en el bloque de datos estructurados');
  check(!hrefsOf(html).some((h) => /javascript:/i.test(h)), 'y tampoco en el HTML, como ya era');

  // La regla, escrita como test: sameAs ⊆ href de la página.
  // Con direccion: el link "Como llegar" solo se renderiza si hay `address`,
  // asi que sin ella el maps_uri valido estaria en sameAs y no en ningun href
  // — asimetria real de la pagina, no del filtro.
  const ok = basePage({
    contact: { address: 'Av. Siempreviva 742', website: 'HTTPS://MiSitio.com.AR/Ruta', maps_uri: 'https://maps.google.com/?cid=123' },
  });
  const ldOk = JSON.parse(buildJsonLd(ok, URL_BASE).replace(/\\u003c/g, '<'));
  const hrefsOk = hrefsOf(renderBusiness(ok, URL_BASE));
  check(ldOk.sameAs.length === 2, 'las URLs legítimas sí siguen en sameAs');
  check(ldOk.sameAs.every((u) => hrefsOk.includes(u)),
    'y TODO sameAs aparece también como href: misma cadena, misma serialización canónica');
  check(ldOk.sameAs.includes('https://misitio.com.ar/Ruta'),
    'se emite lo que leyó el parser, no lo que tipeó el dueño (mayúsculas normalizadas)');

  // http: es válido donde lo tipea una persona, y sólo ahí.
  const mixto = basePage({ contact: { website: 'http://viejositio.com.ar', maps_uri: 'http://maps.google.com/?cid=1' } });
  const ldMixto = JSON.parse(buildJsonLd(mixto, URL_BASE).replace(/\\u003c/g, '<'));
  check(ldMixto.sameAs.length === 1 && ldMixto.sameAs[0] === 'http://viejositio.com.ar/',
    'sameAs respeta los Sets distintos: http para el sitio del dueño, no para el link que arma una máquina');
}

// ══════════════════════════════════════════════════════════════
section('HANDLER · manejo de errores (H1)');
// ══════════════════════════════════════════════════════════════
// El handler exportado no se probaba: ni la caché, ni el 404/503, ni la forma
// del body del motor — exactamente donde vivía H1. Se prueba SIN RED: el motor
// es un `fetch` stubbeado y el reloj se controla con `Date.now`, así esto sigue
// corriendo con node pelado y sin levantar nada.
{
  const handler = require(join(ROOT, 'api', 'page.js'));
  const cache = __internals.cache;

  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realErr = console.error;

  /** Una `res` con la misma superficie que usa el handler. */
  function fakeRes() {
    return {
      headers: {}, code: null, body: '',
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      send(html) { this.body = html; return this; },
    };
  }

  /** Corre el handler con un motor falso, un reloj fijo y los logs capturados. */
  async function call(slug, fetchImpl, at) {
    const logs = [];
    globalThis.fetch = fetchImpl;
    Date.now = () => at;
    console.error = (line) => logs.push(String(line));
    const res = fakeRes();
    let threw = null;
    try { await handler({ query: { slug } }, res); } catch (e) { threw = e; }
    console.error = realErr;
    Date.now = realNow;
    globalThis.fetch = realFetch;
    return { res, logs, threw, log: logs.length === 1 ? JSON.parse(logs[0]) : null };
  }

  const motorOk = (page) => async () => ({ status: 200, ok: true, json: async () => ({ ok: true, page }) });
  const motorBody = (body) => async () => ({ status: 200, ok: true, json: async () => body });
  const motorCaido = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); };
  const motor404 = async () => ({ status: 404, ok: false });

  const T0 = 1700000000000;
  const MIN = 60 * 1000;
  const PAGINA = { name: 'Café Luna', wa_link: 'https://wa.me/5491155554444', catalog: [{ name: 'Flat white' }] };

  // ── Un 200 con otra forma NO es un 404, y no pisa la copia de rescate ──────
  {
    let r = await call('negocio-a', motorOk(PAGINA), T0);
    check(r.res.code === 200, 'setup · el motor contesta bien y la página sale 200');

    r = await call('negocio-a', motorBody({}), T0 + 6 * MIN);
    check(r.res.code !== 404, 'body inesperado → NO se responde 404 (antes: "Acá no hay nada" sobre un negocio que existe)');
    check(r.res.code === 200, 'se sirve la copia de rescate en su lugar');
    check(cache.get('negocio-a') && cache.get('negocio-a').status === 200 && cache.get('negocio-a').at === T0,
      'y la entrada 200 del Map queda INTACTA — el fallo no la pisa');
    check(r.log && r.log.step === 'engine_shape', 'queda logueado, y distingue "cambió el contrato" de "se cayó"');
    check(r.log && r.log.served === 'stale', 'el log dice qué se terminó sirviendo');

    r = await call('negocio-a', motorCaido, T0 + 7 * MIN);
    check(r.res.code === 200, 'y si DESPUÉS se cae el motor, el rescate sigue existiendo (antes: 503, la copia ya estaba pisada)');
    check(r.log && r.log.step === 'engine_fetch', 'la caída se loguea como otro paso distinto');
  }

  // ── Un 404 REAL sí reemplaza la copia: despublicar tiene que funcionar ─────
  {
    let r = await call('negocio-b', motorOk(PAGINA), T0);
    check(r.res.code === 200, 'setup · negocio publicado');

    r = await call('negocio-b', motor404, T0 + 6 * MIN);
    check(r.res.code === 404, 'un 404 real del motor sí responde 404');
    check(cache.get('negocio-b').status === 404, 'y sí reemplaza la copia de rescate (asimetría deliberada con el caso de arriba)');

    r = await call('negocio-b', motorCaido, T0 + 8 * MIN);
    check(r.res.code === 503, 'con el motor caído, una página despublicada NO reaparece desde la caché');
  }

  // ── Render roto: 500 controlado en AMBAS visitas, y sin envenenar el Map ───
  {
    const ROTA = { name: 'X', wa_link: 'https://wa.me/5491155554444', catalog: [null] };

    let r = await call('negocio-c', motorOk(ROTA), T0);
    check(r.threw === null, '1ª visita · un render que explota NO escapa como excepción');
    check(r.res.code === 500, 'sale 500 controlado, no el 503 de "motor caído" (que mandaría a mirar el lugar equivocado)');
    check(r.res.headers['Cache-Control'] === 'no-store', 'y no se cachea');
    check(/script-src 'none'/.test(r.res.headers['Content-Security-Policy']), 'con la CSP estricta, sin el hash de un JSON-LD que no se emitió');
    check(r.log && r.log.step === 'render', 'logueado como fallo de render');
    check(!cache.has('negocio-c'), 'la página que no se puede dibujar NO entra al Map');

    r = await call('negocio-c', motorOk(ROTA), T0 + 1000);
    check(r.threw === null && r.res.code === 500,
      '2ª visita · también 500 controlado (antes: excepción no manejada fuera del try → 500 genérico de Vercel, cero logs)');
  }

  // ── Todo fallo deja traza, y ninguna traza lleva datos del negocio ─────────
  {
    let r = await call('negocio-d', motorCaido, T0);
    check(r.res.code === 503, 'motor caído sin copia previa → 503');
    check(r.logs.length === 1, 'y queda UNA línea en el log (antes: cero, el catch era mudo)');
    check(r.log.slug === 'negocio-d' && r.log.step === 'engine_fetch' && r.log.served === '503',
      'con el slug, el paso que falló y qué se sirvió');
    check(Object.keys(r.log).sort().join(',') === 'err,evt,msg,served,slug,step',
      'exactamente esos campos: ni stack, ni body del motor, ni objeto page');

    const CON_PII = {
      name: 'Café Luna', wa_link: 'https://wa.me/5491155554444',
      contact: { phone: '+54 9 11 5555-4444', address: 'Av. Siempreviva 742' },
      catalog: [null],
    };
    r = await call('negocio-e', motorOk(CON_PII), T0);
    const todo = r.logs.join('\n');
    check(r.res.code === 500, 'setup · esa página explota al renderizar');
    check(!/5555-4444/.test(todo) && !/Siempreviva/.test(todo) && !/Café Luna/.test(todo),
      'NINGÚN dato del negocio (teléfono, dirección, nombre) aparece en el log');
    check(/negocio-e/.test(todo), 'pero el slug sí: es público y sin él no se sabe qué negocio se cayó');

    r = await call('negocio-f', motorOk(PAGINA), T0);
    check(r.res.code === 200 && r.logs.length === 0, 'el camino feliz no ensucia los logs');
  }
}

// ── Veredicto ────────────────────────────────────────────────
section('VEREDICTO');
const ok = failed === 0;
console.log('');
console.log(ok
  ? '  ╔══════════════════════════════════════════╗\n  ║   api/page.js: PASS ✓                    ║\n  ╚══════════════════════════════════════════╝'
  : '  ╔══════════════════════════════════════════╗\n  ║   api/page.js: FAIL ✗                    ║\n  ╚══════════════════════════════════════════╝');
console.log(`  Checks: ${passed} passed${failed ? ', ' + failed + ' failed' : ''}`);
process.exit(ok ? 0 : 1);
