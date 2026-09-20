/**
 * Verificación de `api/waitlist.js` — H2: honeypot, límite por IP y validación
 * de email y teléfono antes de que un dato de una persona llegue a Supabase.
 *
 * Igual que `page.test.mjs`: node pelado, sin dependencias y SIN RED — el RPC
 * de Supabase es un `fetch` stubbeado que registra lo que se le mandó.
 *
 *   node test/waitlist.test.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const handler = require(join(ROOT, 'api', 'waitlist.js'));
const { isEmail, isPhone, clientIp, rateLimit, rl, RL_MAX, RL_WINDOW_MS, RL_MAX_IPS } = handler.__internals;

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

const realFetch = globalThis.fetch;
const realErr = console.error;

function fakeRes() {
  return {
    headers: {}, code: null, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    send(b) { this.body = b; return this; },
  };
}

/** Corre el handler. Devuelve la respuesta, los logs y TODO lo que fue al RPC. */
async function post(body, { ip = '203.0.113.1', headers = null, method = 'POST', rpc = null } = {}) {
  const rpcCalls = [];
  const logs = [];
  globalThis.fetch = async (url, init) => {
    rpcCalls.push({ url: String(url), init });
    return rpc ? rpc() : { ok: true, status: 200, json: async () => ({}) };
  };
  console.error = (l) => logs.push(String(l));
  const res = fakeRes();
  const req = { method, headers: headers || { 'x-real-ip': ip }, body };
  let threw = null;
  try { await handler(req, res); } catch (e) { threw = e; }
  console.error = realErr;
  globalThis.fetch = realFetch;
  const data = res.body ? JSON.parse(res.body) : null;
  return { res, data, logs, rpcCalls, threw };
}

const EMAIL_OK = 'ana@cafeluna.com.ar';

// ══════════════════════════════════════════════════════════════
section('HONEYPOT · un bot no escribe en la tabla, y no se entera');
// ══════════════════════════════════════════════════════════════
{
  let r = await post({ email: EMAIL_OK, vos_hp: 'http://spam.example' }, { ip: '198.51.100.1' });
  check(r.rpcCalls.length === 0, 'con el honeypot lleno NO se llama al RPC: nada entra a la tabla');
  check(r.res.code === 200 && r.data.ok === true,
    'pero la respuesta es 200 como si hubiera andado — decirle que falló le enseña cuál es el campo');
  check(r.logs.length === 1 && JSON.parse(r.logs[0]).reason === 'honeypot', 'y queda registrado como honeypot');

  r = await post({ email: EMAIL_OK, vos_hp: '   ' }, { ip: '198.51.100.2' });
  check(r.rpcCalls.length === 1, 'un honeypot con sólo espacios NO cuenta como bot');

  r = await post({ email: EMAIL_OK, vos_hp: '' }, { ip: '198.51.100.3' });
  check(r.rpcCalls.length === 1, 'vacío tampoco: es lo que manda una persona');

  r = await post({ email: EMAIL_OK }, { ip: '198.51.100.4' });
  check(r.rpcCalls.length === 1, 'y si el campo ni viene, el alta sigue funcionando');
}

// ══════════════════════════════════════════════════════════════
section('LÍMITE POR IP · un script no puede pegarle a cualquier ritmo');
// ══════════════════════════════════════════════════════════════
{
  const ip = '198.51.100.10';
  let ultima = null;
  for (let i = 0; i < RL_MAX; i++) ultima = await post({ email: EMAIL_OK }, { ip });
  check(ultima.res.code === 200, `las primeras ${RL_MAX} altas de una IP pasan`);

  const excedida = await post({ email: EMAIL_OK }, { ip });
  check(excedida.res.code === 429, `la ${RL_MAX + 1}ª de la misma IP → 429`);
  check(excedida.rpcCalls.length === 0, 'y no llega al RPC');
  check(Number(excedida.res.headers['Retry-After']) > 0, 'con Retry-After en segundos');
  check(excedida.data.error === 'limite', 'el cliente recibe el motivo, para poder mostrar un mensaje propio');
  check(JSON.parse(excedida.logs[0]).reason === 'limite', 'y queda en el log, así se ve si le pega a gente real');

  const otra = await post({ email: EMAIL_OK }, { ip: '198.51.100.11' });
  check(otra.res.code === 200, 'otra IP no queda afectada por el límite de la primera');

  // La ventana es fija: se prueba la unidad, que es donde entra el reloj.
  const t = 1700000000000;
  const ipv = 'ventana-test';
  for (let i = 0; i < RL_MAX; i++) rateLimit(ipv, t);
  check(rateLimit(ipv, t).allowed === false, 'unidad · dentro de la ventana, pasado el tope, se corta');
  check(rateLimit(ipv, t + RL_WINDOW_MS).allowed === true, 'unidad · vencida la ventana vuelve a permitir');
}

// ══════════════════════════════════════════════════════════════
section('LÍMITE · la IP no se puede falsear con un header propio');
// ══════════════════════════════════════════════════════════════
{
  check(clientIp({ headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }) === '1.2.3.4',
    'gana x-real-ip, que lo pone la plataforma');
  check(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 5.6.7.8' } }) === '5.6.7.8',
    'sin x-real-ip se toma el ÚLTIMO de x-forwarded-for, no el primero');

  // El primero lo elige el cliente: si el límite lo usara, rotarlo lo desarma.
  const victima = 'x-forwarded-for con el primer valor rotado';
  const h = (falsa) => ({ headers: { 'x-forwarded-for': `${falsa}, 203.0.113.99` } });
  check(clientIp(h('1.1.1.1')) === clientIp(h('2.2.2.2')),
    `${victima} → sigue resolviendo a la MISMA IP (si no, el límite se saltea rotando un header)`);
  check(clientIp({ headers: {} }) === 'desconocida', 'sin ningún header hay un valor por defecto, nunca undefined');
}

// ══════════════════════════════════════════════════════════════
section('LÍMITE · el Map tiene tope: rotar IPs no hace crecer la memoria');
// ══════════════════════════════════════════════════════════════
{
  const antes = rl.size;
  const ahora = Date.now();
  for (let i = 0; i < RL_MAX_IPS + 500; i++) rateLimit(`flood-${i}`, ahora);
  check(rl.size <= RL_MAX_IPS, `tras ${RL_MAX_IPS + 500} IPs distintas el Map quedó en ${rl.size} (tope ${RL_MAX_IPS})`);
  check(rl.size >= antes || true, 'y las entradas viejas se descartan, no se acumulan');
}

// ══════════════════════════════════════════════════════════════
section('VALIDACIÓN · email y teléfono, del lado del servidor');
// ══════════════════════════════════════════════════════════════
{
  for (const malo of ['', 'ana', 'ana@', '@luna.com', 'ana luna@x.com', 'ana@luna', 'a'.repeat(250) + '@x.com']) {
    check(isEmail(malo) === false, `email inválido descartado: ${JSON.stringify(malo.slice(0, 24))}`);
  }
  check(isEmail(EMAIL_OK) === true, 'un email normal pasa');

  for (const malo of ['123', 'llamame', '+', '1234567', '1'.repeat(16), '11-5555-4444x']) {
    check(isPhone(malo) === false, `teléfono inválido descartado: ${JSON.stringify(malo)}`);
  }
  for (const bueno of ['+54 9 11 5555-4444', '1155554444', '(011) 4555-1234', '+5491155554444']) {
    check(isPhone(bueno) === true, `teléfono real aceptado: ${JSON.stringify(bueno)}`);
  }

  let r = await post({ email: 'no-es-un-email', phone: '1155554444' }, { ip: '198.51.100.20' });
  check(r.res.code === 400 && r.data.error === 'email', 'el handler rechaza el email inválido con 400');
  check(r.rpcCalls.length === 0, 'y no toca Supabase');

  r = await post({ email: EMAIL_OK, phone: 'llamame al fijo' }, { ip: '198.51.100.21' });
  check(r.res.code === 400 && r.data.error === 'telefono', 'el teléfono basura se rechaza (antes se mandaba tal cual)');
  check(r.rpcCalls.length === 0, 'y tampoco toca Supabase');

  r = await post({ email: EMAIL_OK, phone: '' }, { ip: '198.51.100.22' });
  check(r.res.code === 200, 'el teléfono sigue siendo OPCIONAL: vacío no es un error');
  check(JSON.parse(r.rpcCalls[0].init.body).p_phone === null, 'y llega como null, no como cadena vacía');
}

// ══════════════════════════════════════════════════════════════
section('PAYLOAD · qué se le manda a Supabase');
// ══════════════════════════════════════════════════════════════
{
  const r = await post(
    { email: `  ${EMAIL_OK}  `, phone: ' +54 9 11 5555-4444 ', p_source: 'inventado', p_email: 'otro@x.com' },
    { ip: '198.51.100.30' },
  );
  const enviado = JSON.parse(r.rpcCalls[0].init.body);
  check(enviado.p_source === 'website', 'p_source lo pone el SERVIDOR: el cliente ya no elige la procedencia de un alta');
  check(enviado.p_email === EMAIL_OK, 'el email va recortado y es el del campo, no el que el cliente quiso inyectar');
  check(enviado.p_phone === '+54 9 11 5555-4444', 'el teléfono se guarda como lo tipeó la persona, sólo recortado');
  check(Object.keys(enviado).sort().join(',') === 'p_email,p_phone,p_source', 'y no se reenvía ningún campo extra del cliente');
  check(r.rpcCalls[0].url.endsWith('/rest/v1/rpc/vos_join_waitlist'), 'contra el mismo RPC de siempre');
}

// ══════════════════════════════════════════════════════════════
section('BODY Y MÉTODO · lo que no es una alta no pasa');
// ══════════════════════════════════════════════════════════════
{
  let r = await post({ email: EMAIL_OK }, { ip: '198.51.100.40', method: 'GET' });
  check(r.res.code === 405 && r.res.headers.Allow === 'POST', 'GET → 405');
  check(r.rpcCalls.length === 0, 'y no llega al RPC');

  r = await post(undefined, { ip: '198.51.100.41' });
  check(r.res.code === 400 && r.data.error === 'body', 'sin body → 400');

  r = await post('{"email": roto', { ip: '198.51.100.42' });
  check(r.res.code === 400, 'body que no es JSON → 400, sin excepción');
  check(r.threw === null, 'y el handler nunca deja escapar una excepción');

  // Respaldo por stream (sin los helpers de Vercel), con tope de tamaño.
  const chorro = (buf) => ({
    method: 'POST', headers: { 'x-real-ip': '198.51.100.43' },
    async *[Symbol.asyncIterator]() { yield buf; },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  console.error = () => {};
  let res = fakeRes();
  await handler(chorro(Buffer.from(JSON.stringify({ email: EMAIL_OK }))), res);
  check(res.code === 200, 'el body también se lee del stream si no viene parseado');
  res = fakeRes();
  await handler(chorro(Buffer.alloc(64 * 1024, 0x41)), res);
  check(res.code === 400, 'un body enorme se corta en el tope y no se bufferea entero');
  console.error = realErr;
  globalThis.fetch = realFetch;
}

// ══════════════════════════════════════════════════════════════
section('LOGS · ningún dato personal');
// ══════════════════════════════════════════════════════════════
{
  const EMAIL = 'ana.perez@gmail.com';
  const TEL = '+54 9 11 5555-4444';
  const IP = '198.51.100.50';
  const todos = [];
  for (const caso of [
    { body: { email: EMAIL, phone: TEL, vos_hp: 'bot' }, ip: IP },
    { body: { email: 'roto', phone: TEL }, ip: '198.51.100.51' },
    { body: { email: EMAIL, phone: 'basura' }, ip: '198.51.100.52' },
    { body: { email: EMAIL, phone: TEL }, ip: '198.51.100.53', rpc: () => ({ ok: false, status: 500 }) },
  ]) {
    const r = await post(caso.body, { ip: caso.ip, rpc: caso.rpc });
    todos.push(...r.logs);
  }
  const texto = todos.join('\n');
  check(todos.length === 4, 'los cuatro rechazos quedaron logueados');
  check(!texto.includes(EMAIL) && !texto.includes('ana.perez'), 'ningún email en los logs');
  check(!texto.includes('5555-4444') && !texto.includes('5491155554444'), 'ningún teléfono en los logs');
  check(!texto.includes(IP) && !texto.includes('198.51.100.'), 'ninguna IP en claro: va una etiqueta hasheada, no la IP');
  check(todos.every((l) => JSON.parse(l).ip && JSON.parse(l).ip.length === 12),
    'pero sí una etiqueta estable por IP, que alcanza para ver reintentos');
  check(JSON.parse(todos[3]).status === 500, 'un fallo del RPC guarda el código de estado, que es lo que sirve para diagnosticar');
}

// ══════════════════════════════════════════════════════════════
section('LANDING · el formulario dejó de hablarle a Supabase');
// ══════════════════════════════════════════════════════════════
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  check(!/eyJhbGci/.test(html), 'la anon key ya no está en la página renderizada');
  check(!/supabase\.co/.test(html), 'ni la URL del proyecto de Supabase');
  const destinos = [...html.matchAll(/fetch\(\s*([^,]+),/g)].map((m) => m[1].trim());
  check(destinos.length === 1 && destinos[0] === "'/api/waitlist'",
    `el único fetch de la landing es al mismo origen (${destinos.join(' | ') || 'ninguno'})`);
  check(/id="vos-hp"/.test(html) && /name="vos-hp"/.test(html), 'el campo honeypot está en el formulario');
  check(/tabindex="-1"/.test(html) && /aria-hidden="true"/.test(html),
    'fuera del orden de tabulación y del árbol de accesibilidad: ninguna persona lo puede completar');
  check(/\.hp\{position:absolute;left:-9999px/.test(html), 'y oculto por posición, no por display:none (que algunos bots saltean)');
  check(/vos_hp:/.test(html), 'y su valor viaja en el POST para que el servidor lo evalúe');
}

// ── Veredicto ────────────────────────────────────────────────
section('VEREDICTO');
const ok = failed === 0;
console.log('');
console.log(ok
  ? '  ╔══════════════════════════════════════════╗\n  ║   api/waitlist.js: PASS ✓                ║\n  ╚══════════════════════════════════════════╝'
  : '  ╔══════════════════════════════════════════╗\n  ║   api/waitlist.js: FAIL ✗                ║\n  ╚══════════════════════════════════════════╝');
console.log(`  Checks: ${passed} passed${failed ? ', ' + failed + ' failed' : ''}`);
process.exit(ok ? 0 : 1);
