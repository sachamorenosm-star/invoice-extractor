#!/usr/bin/env node
/**
 * Internationalization foundation: country config, support status, i18n,
 * client intl state (language != country != currency), SEO head tags,
 * static frontend wiring and provider country wiring.
 *
 * Fully offline: the Anthropic SDK is replaced by an in-process fake, no
 * network, no provider keys. Run: node test/i18n-foundation.test.js
 */
require('./helpers/offline');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const countries = require(path.join(ROOT, 'src/utils/countries'));
const I18n = require(path.join(ROOT, 'public/i18n'));
const { createIntlState } = require(path.join(ROOT, 'public/intl'));
const seo = require(path.join(ROOT, 'src/utils/seo'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('PASS: ' + name); pass++; }
  catch (e) { console.log('FAIL: ' + name + '\n  ' + e.message); fail++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('PASS: ' + name); pass++; }
  catch (e) { console.log('FAIL: ' + name + '\n  ' + e.message); fail++; }
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    dump: () => ({ ...data }),
  };
}
const publicCountries = () => countries.listCountries();
// Config sintetica con TUTTI i paesi abilitati: serve solo a provare che lo
// stato client (lingua vs paese) è indipendente a prescindere dal gating.
const allEnabledCountries = () => countries.listCountries().map((c) => ({ ...c, enabledForExtraction: true }));
const newIntl = (opts = {}) => createIntlState({
  storage: memoryStorage(), pathname: '/', countries: publicCountries(), defaultCountryCode: 'IT', ...opts,
});

// ---------------------------------------------------------------- countries
test('country config: centralized, six targets with required fields', () => {
  assert.deepStrictEqual(Object.keys(countries.COUNTRIES).sort(), ['DE', 'ES', 'FR', 'IT', 'PT', 'US']);
  for (const c of publicCountries()) {
    for (const f of ['code', 'displayName', 'defaultLocale', 'defaultCurrency', 'taxLabel', 'supportStatus']) {
      assert.ok(c[f], `${c.code}.${f} missing`);
    }
    assert.ok(Object.values(countries.SUPPORT_STATUS).includes(c.supportStatus));
    assert.ok(I18n.isSupportedLocale(c.defaultLocale), `${c.code} defaultLocale not a UI locale`);
  }
});

test('country config: tax labels and currencies as specified', () => {
  const expect = { IT: ['IVA', 'EUR'], FR: ['TVA', 'EUR'], DE: ['MwSt', 'EUR'], ES: ['IVA', 'EUR'], PT: ['IVA', 'EUR'], US: ['Sales Tax', 'USD'] };
  for (const [code, [label, cur]] of Object.entries(expect)) {
    assert.strictEqual(countries.getCountry(code).taxLabel, label);
    assert.strictEqual(countries.getCountry(code).defaultCurrency, cur);
  }
});

test('support status: Italy SUPPORTED, others never fully supported before benchmark', () => {
  assert.strictEqual(countries.getCountry('IT').supportStatus, 'SUPPORTED');
  assert.strictEqual(countries.isFullySupported('IT'), true);
  for (const code of ['FR', 'DE', 'ES', 'PT', 'US']) {
    assert.strictEqual(countries.isFullySupported(code), false, `${code} must not be fully supported`);
    assert.notStrictEqual(countries.getCountry(code).supportStatus, 'SUPPORTED');
  }
  assert.strictEqual(countries.getCountry('US').supportStatus, 'COMING_SOON');
  assert.strictEqual(countries.isCountrySelectable('US'), false);
  assert.strictEqual(countries.isCountrySelectable('DE'), false);
});

test('supportStatus and enabledForExtraction table (IT only enabled)', () => {
  const expected = {
    IT: ['SUPPORTED', true], FR: ['BETA', false], DE: ['BETA', false],
    ES: ['BETA', false], PT: ['BETA', false], US: ['COMING_SOON', false],
  };
  for (const [code, [status, enabled]] of Object.entries(expected)) {
    const c = countries.getCountry(code);
    assert.strictEqual(c.supportStatus, status, `${code} supportStatus`);
    assert.strictEqual(c.enabledForExtraction, enabled, `${code} enabledForExtraction`);
    assert.strictEqual(countries.isCountryEnabledForExtraction(code), enabled, code);
  }
  assert.strictEqual(countries.isCountryEnabledForExtraction('XX'), false);
  assert.strictEqual(countries.isCountryEnabledForExtraction(undefined), false);
  // fail-closed: valori non strettamente true non abilitano
  for (const v of ['true', 1, undefined, null]) {
    const saved = countries.COUNTRIES.IT;
    // COUNTRIES è congelato: verifica la regola sul lookup tramite copia
    assert.strictEqual({ ...saved, enabledForExtraction: v }.enabledForExtraction === true, false, String(v));
  }
});

test('country lookup is safe and case-insensitive', () => {
  assert.strictEqual(countries.getCountry('de').code, 'DE');
  for (const bad of ['constructor', '__proto__', 'XX', '', null, undefined, 5]) {
    assert.strictEqual(countries.getCountry(bad), null, String(bad));
  }
});

test('resolveRequestCountry: default IT, validation, non-enabled rejected', () => {
  assert.deepStrictEqual(countries.resolveRequestCountry(undefined), { ok: true, countryCode: 'IT' });
  assert.deepStrictEqual(countries.resolveRequestCountry(''), { ok: true, countryCode: 'IT' });
  assert.deepStrictEqual(countries.resolveRequestCountry('it'), { ok: true, countryCode: 'IT' });
  assert.strictEqual(countries.resolveRequestCountry('XX').code, 'INVALID_COUNTRY_CODE');
  for (const code of ['FR', 'DE', 'ES', 'PT', 'US', 'de']) {
    const r = countries.resolveRequestCountry(code);
    assert.strictEqual(r.ok, false, code);
    assert.strictEqual(r.status, 400, code);
    assert.strictEqual(r.code, 'COUNTRY_NOT_AVAILABLE', code);
  }
});

test('currency is independent from country: only an expected hint', () => {
  assert.strictEqual(countries.getExpectedCurrency('DE'), 'EUR');
  assert.strictEqual(countries.getExpectedCurrency('US'), 'USD');
  // EUR does not identify a country: several countries share it.
  const eurCountries = publicCountries().filter((c) => c.defaultCurrency === 'EUR');
  assert.ok(eurCountries.length > 1);
  assert.strictEqual(countries.getExpectedCurrency('XX'), null);
});

// -------------------------------------------------------------------- i18n
test('i18n: six locales, default and fallback defined', () => {
  assert.deepStrictEqual(I18n.SUPPORTED_LOCALES, ['it', 'en', 'fr', 'de', 'es', 'pt']);
  assert.strictEqual(I18n.DEFAULT_LOCALE, 'it');
  assert.ok(I18n.isSupportedLocale(I18n.FALLBACK_LOCALE));
});

test('i18n: every locale defines every key of the fallback dictionary', () => {
  const keys = Object.keys(I18n.DICTIONARIES[I18n.FALLBACK_LOCALE]);
  for (const l of I18n.SUPPORTED_LOCALES) {
    for (const k of keys) assert.ok(I18n.DICTIONARIES[l][k], `${l} missing ${k}`);
    assert.deepStrictEqual(Object.keys(I18n.DICTIONARIES[l]).sort(), [...keys].sort(), `${l} has extra/missing keys`);
  }
});

test('i18n: fallback locale for unknown locale and for missing keys', () => {
  assert.strictEqual(I18n.t('xx', 'country.label'), I18n.t('it', 'country.label'));
  assert.strictEqual(I18n.t(undefined, 'country.label'), I18n.t('it', 'country.label'));
  assert.strictEqual(I18n.t('en', 'does.not.exist'), 'does.not.exist');
  const saved = I18n.DICTIONARIES.fr['lang.label'];
  delete I18n.DICTIONARIES.fr['lang.label'];
  try { assert.strictEqual(I18n.t('fr', 'lang.label'), I18n.DICTIONARIES.it['lang.label']); }
  finally { I18n.DICTIONARIES.fr['lang.label'] = saved; }
});

test('i18n: translations differ per language and interpolate', () => {
  assert.notStrictEqual(I18n.t('de', 'country.label'), I18n.t('en', 'country.label'));
  assert.strictEqual(I18n.t('en', 'country.label'), 'Document country');
  assert.strictEqual(I18n.t('it', 'country.label'), 'Paese del documento');
  assert.ok(I18n.t('en', 'country.currencyHint', { currency: 'USD' }).includes('USD'));
  assert.strictEqual(I18n.normalizeLocale('fr-CA'), 'fr');
  assert.strictEqual(I18n.normalizeLocale('zz'), null);
  assert.strictEqual(I18n.localeFromPath('/de/'), 'de');
  assert.strictEqual(I18n.localeFromPath('/api/config'), null);
});

// --------------------------------------------- language selector + independence
test('language selector: persists, validates, restores', () => {
  const storage = memoryStorage();
  const a = newIntl({ storage });
  assert.strictEqual(a.getLocale(), 'it');
  assert.strictEqual(a.setLocale('fr'), true);
  assert.strictEqual(a.setLocale('klingon'), false);
  assert.strictEqual(a.getLocale(), 'fr');
  assert.strictEqual(newIntl({ storage }).getLocale(), 'fr'); // refresh
});

test('language: localized URL wins over stored preference; corrupt storage ignored', () => {
  assert.strictEqual(newIntl({ storage: memoryStorage({ ie_lang: 'fr' }), pathname: '/de/' }).getLocale(), 'de');
  assert.strictEqual(newIntl({ storage: memoryStorage({ ie_lang: '<script>' }) }).getLocale(), 'it');
  assert.strictEqual(newIntl({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } }).getLocale(), 'it');
});

test('country selector: options follow country config and status', () => {
  const s = newIntl();
  const opts = Object.fromEntries(s.getCountryOptions().map((o) => [o.code, o]));
  assert.strictEqual(Object.keys(opts).length, 6);
  assert.strictEqual(opts.IT.disabled, false);
  for (const code of ['FR', 'DE', 'ES', 'PT', 'US']) assert.strictEqual(opts[code].disabled, true, code);
  assert.ok(opts.IT.label.includes('Supportato'));
  for (const code of ['FR', 'DE', 'ES', 'PT']) {
    assert.ok(opts[code].label.includes('Beta') && opts[code].label.includes('prossimamente'), opts[code].label);
  }
  assert.ok(opts.US.label.includes('Prossimamente'));
  for (const code of ['FR', 'DE', 'ES', 'PT', 'US']) {
    assert.strictEqual(s.setCountry(code), false, code); // non abilitato: non selezionabile
    assert.strictEqual(s.getCountry(), 'IT');
  }
  assert.strictEqual(s.getCountry(), 'IT');
  assert.strictEqual(s.setCountry('ZZ'), false);
});

test('country != language: UI it + document country DE (synthetic all-enabled config)', () => {
  const storage = memoryStorage();
  const s = newIntl({ storage, countries: allEnabledCountries() });
  assert.strictEqual(s.setLocale('it'), true);
  assert.strictEqual(s.setCountry('DE'), true);
  assert.strictEqual(s.getLocale(), 'it');
  assert.strictEqual(s.getCountry(), 'DE');
  const r = newIntl({ storage, countries: allEnabledCountries() }); // after refresh both persist independently
  assert.strictEqual(r.getLocale(), 'it');
  assert.strictEqual(r.getCountry(), 'DE');
});

test('country != language: UI en + document country IT', () => {
  const s = newIntl();
  assert.strictEqual(s.setLocale('en'), true);
  assert.strictEqual(s.getCountry(), 'IT');
  assert.strictEqual(s.getLocale(), 'en');
});

test('changing one never changes the other (all combinations)', () => {
  for (const l of I18n.SUPPORTED_LOCALES) {
    for (const code of ['IT', 'FR', 'DE', 'ES', 'PT']) {
      const s = newIntl({ countries: allEnabledCountries() });
      s.setCountry(code);
      s.setLocale(l);
      assert.strictEqual(s.getCountry(), code, `country changed by locale ${l}`);
      s.setLocale('en');
      s.setLocale(l);
      assert.strictEqual(s.getCountry(), code);
      const before = s.getLocale();
      s.setCountry('IT');
      s.setCountry(code);
      assert.strictEqual(s.getLocale(), before, `locale changed by country ${code}`);
    }
  }
});

test('currency stays independent of both language and country selection', () => {
  const s = newIntl({ countries: allEnabledCountries() });
  s.setCountry('DE');
  const hint = s.getExpectedCurrency();
  s.setLocale('en');
  assert.strictEqual(s.getExpectedCurrency(), hint); // language does not alter it
  assert.strictEqual(hint, 'EUR');
  assert.strictEqual(typeof s.getCountry(), 'string'); // hint is not exposed as country
});

test('stored non-enabled country (US/DE) is ignored (falls back to default)', () => {
  for (const code of ['US', 'DE', 'FR']) {
    assert.strictEqual(newIntl({ storage: memoryStorage({ ie_country: code }) }).getCountry(), 'IT', code);
  }
});

test('language and country independent with the REAL config: any locale keeps IT', () => {
  for (const l of I18n.SUPPORTED_LOCALES) {
    const s = newIntl();
    s.setLocale(l);
    assert.strictEqual(s.getCountry(), 'IT', l);
    assert.strictEqual(s.getLocale(), l);
  }
});

// --------------------------------------------------------------------- SEO
test('SEO: only SEO-exposed locales declare their own lang/canonical/hreflang', () => {
  assert.deepStrictEqual(I18n.SEO_EXPOSED_LOCALES, ['it']);
  for (const l of I18n.SUPPORTED_LOCALES) {
    assert.ok(I18n.isSupportedLocale(l)); // technically available
    const html = seo.renderLocalizedIndex(l, 'https://example.test');
    const canon = html.match(/<link rel="canonical" href="([^"]+)"/g) || [];
    assert.strictEqual(canon.length, 1, 'exactly one canonical');
    assert.strictEqual((html.match(/<meta name="description"/g) || []).length, 1);
    assert.strictEqual((html.match(/<meta name="robots"/g) || []).length, I18n.isSeoExposed(l) ? 0 : 1, l);
    if (I18n.isSeoExposed(l)) {
      assert.ok(html.includes(`<html lang="${l}">`), l);
      assert.ok(html.includes(`<title>${I18n.t(l, 'meta.title')}</title>`.replace(/&/g, '&amp;')), l);
      assert.ok(canon[0].includes(`https://example.test/${l}/`), `self canonical for ${l}`);
      assert.ok(!/noindex/.test(html), l);
    } else {
      // contenuto ancora italiano: nessuna lingua diversa dichiarata
      assert.ok(html.includes('<html lang="it">'), l);
      assert.ok(html.includes(`<title>${I18n.t('it', 'meta.title')}</title>`.replace(/&/g, '&amp;')), l);
      assert.ok(canon[0].includes('https://example.test/it/'), `${l} canonical -> /it/`);
      assert.ok(/<meta name="robots" content="noindex,follow" \/>/.test(html), l);
      assert.ok(!/hreflang=/.test(html), `${l} must not emit hreflang`);
      assert.ok(!html.includes(`og:locale" content="${I18n.OG_LOCALES[l]}"`), l);
    }
  }
});

test('SEO: hreflang only for exposed locales + x-default, coherent with canonical', () => {
  const hrefsFor = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const pairs = hrefsFor(seo.renderLocalizedIndex('it', 'https://example.test/'));
  assert.deepStrictEqual(pairs.map((p) => p[0]), ['it', 'x-default']);
  assert.strictEqual(Object.fromEntries(pairs)['x-default'], 'https://example.test/it/');
  assert.strictEqual(Object.fromEntries(pairs).it, 'https://example.test/it/');
  // nessun hreflang verso locale non esposte
  for (const l of ['en', 'fr', 'de', 'es', 'pt']) {
    assert.ok(!seo.buildAlternates('https://example.test').some((a) => a.hreflang === l), l);
  }
});

test('SEO: no meta keywords, no overclaiming, attribute escaping', () => {
  const html = seo.renderLocalizedIndex('it', 'https://example.test"><script>x</script>');
  assert.ok(!/name="keywords"/i.test(html));
  assert.ok(!html.includes('"><script>x</script>'));
  const all = JSON.stringify(I18n.DICTIONARIES) + fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(!/100\s?%\s*(accura|preciso|precis)|tax[- ]compliant|legally certified|fiscalmente conform|conforme in tutti/i.test(all));
});

// ---------------------------------------------------------- static frontend
test('frontend: selectors, accessible labels, script order, country_code sent', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(/<label[^>]+for="country-select"/.test(html));
  assert.ok(/<label[^>]+for="lang-select"/.test(html));
  assert.ok(html.indexOf('id="country-picker"') < html.indexOf('id="drop-zone"'), 'country selector before upload');
  assert.ok(html.indexOf('/i18n.js') < html.indexOf('/intl.js') && html.indexOf('/intl.js') < html.indexOf('/app.js'));
  for (const l of I18n.SUPPORTED_LOCALES) assert.ok(html.includes(`<option value="${l}">`), l);
  assert.ok(/aria-live="polite"/.test(html));
  assert.ok(app.includes("formData.append('country_code', intl.getCountry())"));
  assert.ok(app.includes("formData.append('invoices'"), 'upload flow intact');
});

// ------------------------------------------------- provider country wiring
(async () => {
  const sdkPath = require.resolve('@anthropic-ai/sdk');
  let lastRequest = null;
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (req) => {
          lastRequest = req;
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', input: { supplier: 'ACME', total: 10, currency: 'USD', math_verified: false } }],
          };
        },
      };
    }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };
  process.env.ANTHROPIC_API_KEY = 'fake-key-not-used-offline';
  const { extractInvoiceData } = require(path.join(ROOT, 'src/services/claudeService'));
  process.env.ANTHROPIC_API_KEY = '';

  await testAsync('provider wiring: country_code reaches records, currency untouched', async () => {
    const res = await extractInvoiceData(Buffer.from('x'), 'image/png', 'a.png', { countryCode: 'DE' });
    assert.strictEqual(res.records[0].country_code, 'DE');
    assert.strictEqual(res.records[0].currency, 'USD'); // currency stays document data
  });

  await testAsync('provider wiring: optional, backward compatible, prompt unchanged by country', async () => {
    const a = await extractInvoiceData(Buffer.from('x'), 'image/png', 'a.png');
    assert.ok(!('country_code' in a.records[0]));
    const sys1 = lastRequest.system;
    await extractInvoiceData(Buffer.from('x'), 'image/png', 'a.png', { countryCode: 'FR' });
    assert.strictEqual(lastRequest.system, sys1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL: ' + e.stack); process.exit(1); });
