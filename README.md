# VOS — vos.chat
Virtual Operation System. A WhatsApp AI agent for LatAm businesses.
It sounds like you.

## Verificación

```
node test/page.test.mjs
```

Sin dependencias ni `npm install`: chequea `api/page.js` — la allowlist de
esquemas de los `href` (un `website` con `javascript:` no produce ningún `<a>`,
una URL https se renderiza igual que siempre) y los headers de seguridad de la
respuesta, incluido que el hash de la CSP corresponda al bloque JSON-LD que se
emite. Sale con código 1 si algo falla.
