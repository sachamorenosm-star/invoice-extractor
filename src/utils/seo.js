// SEO internazionale: rende public/index.html per una lingua con lang,
// title/description localizzati, canonical, hreflang e x-default.
// Nessun meta keywords. Ogni versione linguistica ha un canonical
// autoreferenziale e tutte si referenziano a vicenda via hreflang.

const path = require('path');
const fs = require('fs');
const I18n = require('../../public/i18n');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');
let cachedIndex = null;

function loadIndexHtml() {
  if (cachedIndex === null) cachedIndex = fs.readFileSync(INDEX_PATH, 'utf8');
  return cachedIndex;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function localizedPath(locale) {
  return `/${locale}/`;
}

// Solo le locale realmente localizzate (SEO_EXPOSED_LOCALES) hanno hreflang.
// x-default punta alla versione nella lingua di default.
function buildAlternates(baseUrl) {
  const base = trimBase(baseUrl);
  const alternates = I18n.SEO_EXPOSED_LOCALES.map((l) => ({ hreflang: l, href: base + localizedPath(l) }));
  alternates.push({ hreflang: 'x-default', href: base + localizedPath(I18n.DEFAULT_LOCALE) });
  return alternates;
}

// Locale tecnicamente disponibile ma NON esposta alla SEO: contenuto principale
// ancora in italiano. Nessuna dichiarazione di lingua diversa, canonical sulla
// versione di default, noindex e nessun hreflang.
function buildHiddenLocaleHeadTags(baseUrl) {
  const base = trimBase(baseUrl);
  const def = I18n.DEFAULT_LOCALE;
  return [
    '<meta name="robots" content="noindex,follow" />',
    `<link rel="canonical" href="${escapeAttr(base + localizedPath(def))}" />`,
  ].join('\n  ');
}

function buildHeadTags(locale, baseUrl) {
  if (!I18n.isSeoExposed(locale)) return buildHiddenLocaleHeadTags(baseUrl);
  const base = trimBase(baseUrl);
  const title = I18n.t(locale, 'meta.title');
  const description = I18n.t(locale, 'meta.description');
  const lines = [
    `<link rel="canonical" href="${escapeAttr(base + localizedPath(locale))}" />`,
    ...buildAlternates(baseUrl).map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${escapeAttr(a.href)}" />`),
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:locale" content="${I18n.OG_LOCALES[locale]}" />`,
    `<meta property="og:url" content="${escapeAttr(base + localizedPath(locale))}" />`,
  ];
  return lines.join('\n  ');
}

function renderLocalizedIndex(locale, baseUrl) {
  const requested = I18n.resolveLocale(locale);
  // Il documento servito è italiano finché la locale non è esposta: lang,
  // title e description restano coerenti col contenuto reale.
  const loc = I18n.isSeoExposed(requested) ? requested : I18n.DEFAULT_LOCALE;
  const title = escapeAttr(I18n.t(loc, 'meta.title'));
  const description = escapeAttr(I18n.t(loc, 'meta.description'));
  return loadIndexHtml()
    .replace(/<html lang="[^"]*">/, `<html lang="${loc}">`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${description}" />`)
    .replace('</head>', `  ${buildHeadTags(requested, baseUrl)}\n</head>`);
}

module.exports = { renderLocalizedIndex, buildAlternates, buildHeadTags, localizedPath };
