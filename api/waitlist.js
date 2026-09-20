/**
 * POST /api/waitlist — la lista de espera de vos.chat.
 *
 * Antes el formulario de `index.html` le pegaba DIRECTO al RPC
 * `vos_join_waitlist` de Supabase desde el browser, con la anon key a la vista
 * (publica por diseno) y una sola defensa: un regex de email en el cliente. Sin
 * honeypot, sin limite por IP, sin validar el telefono, y con `p_source`
 * elegido por el cliente. Lo que entra a esa tabla son emails y telefonos de
 * personas reales, y el copy de la landing promete que alguien del equipo puede
 * LLAMAR a ese numero: un numero ajeno ahi termina en una llamada a un tercero.
 *
 * Ahora el formulario postea acá, mismo origen, y esta funcion valida, frena y
 * recien despues habla con Supabase.
 *
 * HASTA DONDE LLEGA ESTO, dicho sin vueltas:
 *   - La anon key sigue siendo publica y el RPC sigue siendo invocable
 *     directamente por cualquiera que la lea de un deploy viejo o de la
 *     historia del repo. Esta funcion NO puede impedirlo. La defensa definitiva
 *     vive en `vos_join_waitlist` (vos-app): validar, deduplicar y limitar allá.
 *     Esto es la primera linea, no la ultima.
 *   - El limite por IP es EN MEMORIA y por instancia. Vercel levanta varias
 *     instancias en paralelo, asi que frena rafagas que caen en la misma
 *     instancia, no un ataque distribuido. Un limite de verdad necesita estado
 *     compartido (el propio Supabase). Se eligio igual porque es lo que se
 *     puede hacer en este repo y corta el caso comun: un script pegandole al
 *     formulario.
 *
 * No se agrego chequeo de `Origin`: un atacante con curl no manda `Origin` y
 * pasaria igual, y una allowlist de origenes rompe los deploys de preview. El
 * limite y la validacion cubren mas por menos riesgo.
 */

const { createHash, randomBytes } = require('node:crypto');

// Mismo patron que `ENGINE` en api/page.js: variable de entorno primero, valor
// publico como respaldo para que el formulario no dependa de configurar nada.
// La anon key NO es un secreto (es la clave publica del cliente, ver la
// auditoria), pero sacarla de index.html la quita de la pagina renderizada.
// Pasarla a variables de entorno en Vercel es cambiar estas dos lineas.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqjtrwijfoyuqrkeelve.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xanRyd2lqZm95dXFya2VlbHZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNTQ5NjYsImV4cCI6MjA5ODkzMDk2Nn0.Rx7JOibEeQnao0xV5jeLJFATid18dVam-3guqvH8Og8';

const RPC_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4 * 1024;

// ── Limite por IP ────────────────────────────────────────────────────────────
//
// Ventana fija. 6 altas por IP cada 10 minutos: anotarse es algo que una
// persona hace UNA vez, y 6 deja lugar a una oficina o un evento detras de un
// mismo NAT sin que nadie quede afuera. Cuando el limite corta queda una linea
// en el log, asi que si le pega a gente real se ve y se sube.
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 6;
// Tope del Map: sin esto, rotar IPs hace crecer la memoria sin limite — el
// mismo defecto que H6 senala en la cache de api/page.js.
const RL_MAX_IPS = 5000;

const rl = new Map(); // ip -> { start, n }

/**
 * IP del visitante.
 *
 * Se prefiere `x-real-ip`, que en Vercel lo pone la plataforma. `x-forwarded-for`
 * NO sirve leyendo el primero: si el cliente manda su propio XFF, Vercel le
 * agrega la IP real DETRAS, asi que el primer valor lo elige el atacante y
 * rotarlo desarma el limite entero. Por eso el respaldo es el ULTIMO de la
 * lista, que es el que agrega el proxy mas cercano.
 */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const real = String(h['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : 'desconocida';
}

// Sal aleatoria por proceso: el hash sirve para correlacionar reintentos dentro
// de la misma instancia —que es el alcance del limite— y para nada mas. La IP en
// claro no entra a estos logs; si hiciera falta, esta en el access log de Vercel.
const IP_SALT = randomBytes(16);

/** Etiqueta corta y no reversible de una IP, para los logs. */
function ipTag(ip) {
  return createHash('sha256').update(IP_SALT).update(String(ip)).digest('hex').slice(0, 12);
}

/** Saca las entradas vencidas y, si aun sobra, las mas viejas por insercion. */
function evict(now) {
  if (rl.size <= RL_MAX_IPS) return;
  for (const [k, v] of rl) if (now - v.start >= RL_WINDOW_MS) rl.delete(k);
  while (rl.size > RL_MAX_IPS) rl.delete(rl.keys().next().value);
}

function rateLimit(ip, now) {
  const hit = rl.get(ip);
  if (hit && now - hit.start < RL_WINDOW_MS) {
    hit.n += 1;
    return { allowed: hit.n <= RL_MAX, retryAfterS: Math.ceil((hit.start + RL_WINDOW_MS - now) / 1000) };
  }
  rl.delete(ip);
  rl.set(ip, { start: now, n: 1 });
  evict(now);
  return { allowed: true, retryAfterS: 0 };
}

// ── Validacion ───────────────────────────────────────────────────────────────

// El mismo regex que ya usaba el cliente, mas el tope de 254 de la RFC 5321. No
// se pretende decidir si el buzon existe —eso no lo decide un regex— sino
// descartar lo que no puede ser un email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/**
 * Telefono: 8 a 15 digitos, con `+` opcional adelante, ignorando espacios,
 * guiones, puntos y parentesis. 15 es el maximo de E.164; 8 deja pasar un fijo
 * sin caracteristica y descarta el relleno corto. Se valida el FORMATO y se
 * guarda lo que la persona tipeo: normalizarlo cambiaria el dato que ya recibe
 * vos-app, y eso no es decision de este repo.
 */
function isPhone(v) {
  if (typeof v !== 'string' || v.length > 32) return false;
  const limpio = v.replace(/[\s\-.()]/g, '');
  return /^\+?\d{8,15}$/.test(limpio);
}

// ── Logs ─────────────────────────────────────────────────────────────────────
//
// NUNCA el email ni el telefono: son justamente el dato personal que esta
// funcion existe para cuidar. Va el motivo, la etiqueta de IP y nada mas.
function logEvent(fields) {
  try {
    console.error(JSON.stringify({ evt: 'vos-web.waitlist', ...fields }));
  } catch {
    // Loguear no puede tumbar la respuesta.
  }
}

/** Body JSON, con tope. Los helpers de Vercel ya lo parsean; el stream es el respaldo. */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function json(res, code, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(code).send(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'metodo' });
  }

  const ip = clientIp(req);
  const tag = ipTag(ip);
  const now = Date.now();

  const { allowed, retryAfterS } = rateLimit(ip, now);
  if (!allowed) {
    logEvent({ result: 'rechazado', reason: 'limite', ip: tag });
    res.setHeader('Retry-After', String(retryAfterS));
    return json(res, 429, { ok: false, error: 'limite' });
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    logEvent({ result: 'rechazado', reason: 'body', ip: tag });
    return json(res, 400, { ok: false, error: 'body' });
  }

  // HONEYPOT. Un campo que ninguna persona ve ni puede tabular; si viene con
  // algo, lo lleno un bot. Se contesta 200 como si hubiera andado: decirle que
  // fallo es ensenarle cual es el campo. No se escribe nada en la tabla.
  const hp = body.vos_hp;
  if (typeof hp === 'string' && hp.trim() !== '') {
    logEvent({ result: 'descartado', reason: 'honeypot', ip: tag });
    return json(res, 200, { ok: true });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isEmail(email)) {
    logEvent({ result: 'rechazado', reason: 'email', ip: tag });
    return json(res, 400, { ok: false, error: 'email' });
  }

  const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (phoneRaw && !isPhone(phoneRaw)) {
    logEvent({ result: 'rechazado', reason: 'telefono', ip: tag });
    return json(res, 400, { ok: false, error: 'telefono' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vos_join_waitlist`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      // `p_source` lo pone el SERVIDOR. Antes lo mandaba el cliente, asi que
      // cualquiera podia inventar la procedencia de un alta.
      body: JSON.stringify({ p_email: email, p_source: 'website', p_phone: phoneRaw || null }),
    });
    if (!r.ok) {
      logEvent({ result: 'error', reason: 'rpc', status: r.status, ip: tag });
      return json(res, 502, { ok: false, error: 'rpc' });
    }
    return json(res, 200, { ok: true });
  } catch (err) {
    logEvent({ result: 'error', reason: 'red', err: err && err.name ? err.name : 'Error', ip: tag });
    return json(res, 502, { ok: false, error: 'rpc' });
  } finally {
    clearTimeout(timer);
  }
};

// Para `test/waitlist.test.mjs`. Ver la nota equivalente en api/page.js.
module.exports.__internals = {
  isEmail, isPhone, clientIp, rateLimit, ipTag, rl,
  RL_MAX, RL_WINDOW_MS, RL_MAX_IPS, MAX_BODY_BYTES,
};
