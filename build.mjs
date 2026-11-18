// Genera los artículos de vos.chat y el sitemap.
//
// Fuente:  src/articulos/*.html  (un comentario con title, description, path,
//          published, modified, headline y, si cuelga de otra guía,
//          parent_name / parent_path; después, el <article>)
// Salidas: <path>.html por artículo y sitemap.xml (se commitean tal cual; Vercel
//          publica el repo). El estilo, la barra y el pie salen de index.html.
//
// Cada artículo nuevo necesita además, a mano: su rewrite en vercel.json (antes
// del catch-all de páginas de negocio), su slug en la regla de headers de los
// documentos y en RESERVED_SLUGS de api/page.js. test/page.test.mjs lo verifica.
//
// Uso: node build.mjs   (sin dependencias)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://vos.chat';
const HOME = readFileSync(join(RAIZ, 'index.html'), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sinTags = (t) => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const uno = (re, que) => { const m = HOME.match(re); if (!m) throw new Error('no encontré en index.html: ' + que); return m[0]; };

const STYLE = uno(/<style>[\s\S]*?<\/style>/, '<style>');
const FAVICON = uno(/<link rel="icon"[^>]*>/, 'favicon');
const FUENTES = (HOME.match(/<link rel="preconnect"[^>]*>|<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g) || []).join('\n');
const NAV = uno(/<nav class="container nav"[\s\S]*?<\/nav>/, 'nav').replace(/href="#/g, 'href="/#');
const PIE = uno(/<footer class="foot">[\s\S]*?<\/footer>/, 'footer')
  .replace(/href="privacidad\.html"/g, 'href="/privacidad"').replace(/href="terminos\.html"/g, 'href="/terminos"');
const ORG = {
  '@type': 'Organization', '@id': SITE + '/#org', name: 'VOS', url: SITE + '/', logo: SITE + '/og.png', email: 'contact@actavia.tech', telephone: '+5491176539950',
  parentOrganization: { '@type': 'Organization', '@id': 'https://actavia.tech/#org', name: 'Actavia LLC', url: 'https://actavia.tech' },
};

const articulos = [];
const dir = join(RAIZ, 'src/articulos');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
  const src = readFileSync(join(dir, f), 'utf8');
  const fin = src.indexOf('-->');
  const meta = Object.fromEntries([...src.slice(0, fin).matchAll(/^(\w+): (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
  for (const k of ['title', 'description', 'path', 'published', 'modified', 'headline']) {
    if (!meta[k]) throw new Error(`${f}: falta "${k}" en el encabezado`);
  }
  const cuerpo = src.slice(fin + 3).trim();
  const u = SITE + meta.path;
  const faq = [...cuerpo.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)]
    .map((m) => ({ '@type': 'Question', name: sinTags(m[1]), acceptedAnswer: { '@type': 'Answer', text: sinTags(m[2]) } }));
  const rastro = [['vos', SITE + '/']];
  if (meta.parent_path) rastro.push([meta.parent_name, SITE + meta.parent_path]);
  rastro.push([meta.headline, u]);
  const grafo = [
    ORG,
    { '@type': 'Article', '@id': u + '#article', headline: meta.headline, description: meta.description, inLanguage: 'es',
      datePublished: meta.published, dateModified: meta.modified, author: { '@id': SITE + '/#org' }, publisher: { '@id': SITE + '/#org' },
      mainEntityOfPage: u, image: SITE + '/og.png' },
    { '@type': 'BreadcrumbList', itemListElement: rastro.map(([n, it], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: it })) },
  ];
  if (faq.length) grafo.push({ '@type': 'FAQPage', '@id': u + '#faq', inLanguage: 'es', mainEntity: faq });
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': grafo }).replace(/</g, '\\u003c');
  const pagina = `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${u}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="vos.chat">
<meta property="og:url" content="${u}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="es_AR">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${ld}</script>
${FAVICON}
${FUENTES}
${STYLE}
</head>
<body>
<header class="hero">
  ${NAV}
</header>
<main>
${cuerpo}
</main>
${PIE}
</body>
</html>
`;
  const salida = meta.path.replace(/^\//, '') + '.html';
  writeFileSync(join(RAIZ, salida), pagina);
  articulos.push({ path: meta.path, modified: meta.modified });
  console.log(`${salida.padEnd(50)} ${faq.length} preguntas`);
}

const HOY = new Date().toISOString().slice(0, 10);
const filas = [
  { loc: SITE + '/', mod: HOY },
  ...articulos.map((a) => ({ loc: SITE + a.path, mod: a.modified })),
  { loc: SITE + '/privacidad', mod: '2026-11-18' },
  { loc: SITE + '/terminos', mod: '2026-11-18' },
];
writeFileSync(join(RAIZ, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${filas.map((r) => `  <url><loc>${r.loc}</loc><lastmod>${r.mod}</lastmod></url>`).join('\n')}
</urlset>
`);
console.log('sitemap.xml');
