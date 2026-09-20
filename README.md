# VOS — vos.chat
Virtual Operation System. A WhatsApp AI agent for LatAm businesses.
It sounds like you.

## Verificación

```
node test/page.test.mjs
node test/waitlist.test.mjs
```

Sin dependencias, sin `npm install` y **sin red**: el motor y Supabase son
`fetch` stubbeados. Salen con código 1 si algo falla, así que sirven igual desde
un hook o desde CI el día que exista.

`page.test.mjs` cubre `api/page.js` y la configuración del sitio: la allowlist
de esquemas en los `href` **y en el JSON-LD**, el manejo de errores del handler
(motor caído, motor contestando con otro contrato, render que explota), que
ningún fallo pise la copia de rescate ni loguee datos del negocio, el tope y el
vencimiento de la caché, los slugs que son de vos.chat y no de un negocio, y los
headers de seguridad — los que pone la función y los de `vercel.json`, incluido
que la CSP cubra todo lo que las páginas estáticas piden de verdad.

`waitlist.test.mjs` cubre `api/waitlist.js`: honeypot, límite por IP, validación
de email y teléfono, y que los logs no lleven ni un dato personal.

## Notas del repo

### El video sigue en git, a propósito (H7)

`videos/vos-explainer.mp4` pesa 5,37 MB y **es** el repo: el pack completo mide
5,21 MiB. Se evaluó sacarlo y no hay dónde ponerlo hoy — no hay Git LFS
instalado ni `.gitattributes`, no hay Vercel Blob ni ningún CDN configurado en
ninguna parte, y Vercel despliega desde git: sacarlo del repo lo saca del sitio.
Con una sola versión de cada archivo y cero borrados en toda la historia, hoy no
molesta.

**Lo que sí importa:** cada recorte nuevo del video suma otros ~5 MB al
historial, para siempre, aunque después se borre el archivo. Si el video va a
cambiar, primero hay que darle un lugar (Git LFS o Vercel Blob / CDN externo) y
recién después subir la versión nueva. `page.test.mjs` tiene un check que falla
si aparece cualquier archivo nuevo de más de 1 MB, justamente para que esa
decisión no se tome por inercia un martes a la tarde.

### Los `headers` de `vercel.json` se enumeran uno por uno (H4)

Lo natural sería un `source` de `/(.*)`, y es exactamente lo que **no** se puede
hacer acá: también alcanzaría a `/api/page`, y una CSP fija en `vercel.json` le
pisaría a la función la CSP que construye con el **hash** del bloque JSON-LD —
es decir, rompería el structured data, que es la razón por la que esa función
existe. El orden de aplicación entre `vercel.json` y `res.setHeader` no se puede
medir sin desplegar, así que los `source` se enumeran. Si se agrega una página
estática nueva, hay que sumarla a esa lista.
