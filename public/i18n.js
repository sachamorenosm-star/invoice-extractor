/* i18n foundation (browser + Node, no dependencies).
 *
 * La lingua UI è indipendente dal paese del documento e dalla valuta.
 * Aggiungere una lingua: inserire il codice in SUPPORTED_LOCALES e un
 * dizionario in DICTIONARIES. Le chiavi mancanti ricadono su FALLBACK_LOCALE.
 * Solo il nuovo flusso (selettori, metadati) è internazionalizzato; le
 * stringhe legacy restano in italiano finché non migrate.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.I18n = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUPPORTED_LOCALES = ['it', 'en', 'fr', 'de', 'es', 'pt'];
  var DEFAULT_LOCALE = 'it';
  var FALLBACK_LOCALE = 'it';
  // Locale tecnicamente disponibili (UI) != locale esposte alla SEO. Una
  // locale entra in SEO_EXPOSED_LOCALES solo quando il contenuto principale
  // della landing/app è realmente tradotto (oggi solo it: le stringhe legacy
  // della pagina sono italiane). Non aggiungere una locale senza traduzione.
  var SEO_EXPOSED_LOCALES = ['it'];
  var LOCALE_NAMES = { it: 'Italiano', en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português' };
  var OG_LOCALES = { it: 'it_IT', en: 'en_US', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', pt: 'pt_PT' };

  var DICTIONARIES = {
    it: {
      'meta.title': 'InvoiceExtract – Estrazione dati da fatture e ricevute',
      'meta.description': "Estrai i dati da fatture e ricevute (PDF o foto) in dati strutturati, con verifica matematica degli importi. Esporta in Excel o CSV.",
      'lang.label': 'Lingua',
      'country.label': 'Paese del documento',
      'country.help': "Indica il paese di emissione del documento. Non cambia la lingua dell'interfaccia né la valuta.",
      'country.currencyHint': 'Valuta attesa (indicativa): {currency}. La valuta effettiva resta quella letta dal documento.',
      'status.SUPPORTED': 'Supportato',
      'status.BETA': 'Beta',
      'status.COMING_SOON': 'In arrivo',
      'status.BETA.notEnabled': 'Beta – prossimamente disponibile',
      'status.COMING_SOON.notEnabled': 'Prossimamente disponibile',
      'country.betaNotice': 'Supporto beta per {country}: non ancora verificato con benchmark. Controlla sempre i risultati.',
      'country.comingSoonNotice': '{country} non è ancora disponibile.'
    },
    en: {
      'meta.title': 'InvoiceExtract – Invoice and receipt data extraction',
      'meta.description': 'Turn invoices and receipts (PDF or photo) into structured data, with math validation of the amounts. Export to Excel or CSV.',
      'lang.label': 'Language',
      'country.label': 'Document country',
      'country.help': 'Country that issued the document. It does not change the interface language or the currency.',
      'country.currencyHint': 'Expected currency (indicative): {currency}. The actual currency is the one read from the document.',
      'status.SUPPORTED': 'Supported',
      'status.BETA': 'Beta',
      'status.COMING_SOON': 'Coming soon',
      'status.BETA.notEnabled': 'Beta – coming soon',
      'status.COMING_SOON.notEnabled': 'Coming soon',
      'country.betaNotice': 'Beta support for {country}: not yet verified by benchmark. Always check the results.',
      'country.comingSoonNotice': '{country} is not available yet.'
    },
    fr: {
      'meta.title': "InvoiceExtract – Extraction de données de factures et reçus",
      'meta.description': "Transformez factures et reçus (PDF ou photo) en données structurées, avec vérification mathématique des montants. Export Excel ou CSV.",
      'lang.label': 'Langue',
      'country.label': 'Pays du document',
      'country.help': "Pays d'émission du document. Cela ne change ni la langue de l'interface ni la devise.",
      'country.currencyHint': 'Devise attendue (indicative) : {currency}. La devise réelle est celle lue sur le document.',
      'status.SUPPORTED': 'Pris en charge',
      'status.BETA': 'Bêta',
      'status.COMING_SOON': 'Bientôt disponible',
      'status.BETA.notEnabled': 'Bêta – bientôt disponible',
      'status.COMING_SOON.notEnabled': 'Bientôt disponible',
      'country.betaNotice': "Prise en charge bêta pour {country} : pas encore validée par benchmark. Vérifiez toujours les résultats.",
      'country.comingSoonNotice': "{country} n'est pas encore disponible."
    },
    de: {
      'meta.title': 'InvoiceExtract – Datenextraktion aus Rechnungen und Belegen',
      'meta.description': 'Wandeln Sie Rechnungen und Belege (PDF oder Foto) in strukturierte Daten um, mit mathematischer Prüfung der Beträge. Export nach Excel oder CSV.',
      'lang.label': 'Sprache',
      'country.label': 'Land des Dokuments',
      'country.help': 'Land, in dem das Dokument ausgestellt wurde. Es ändert weder die Oberflächensprache noch die Währung.',
      'country.currencyHint': 'Erwartete Währung (Richtwert): {currency}. Maßgeblich ist die Währung im Dokument.',
      'status.SUPPORTED': 'Unterstützt',
      'status.BETA': 'Beta',
      'status.COMING_SOON': 'Demnächst',
      'status.BETA.notEnabled': 'Beta – demnächst verfügbar',
      'status.COMING_SOON.notEnabled': 'Demnächst verfügbar',
      'country.betaNotice': 'Beta-Unterstützung für {country}: noch nicht per Benchmark geprüft. Ergebnisse stets kontrollieren.',
      'country.comingSoonNotice': '{country} ist noch nicht verfügbar.'
    },
    es: {
      'meta.title': 'InvoiceExtract – Extracción de datos de facturas y recibos',
      'meta.description': 'Convierte facturas y recibos (PDF o foto) en datos estructurados, con verificación matemática de los importes. Exporta a Excel o CSV.',
      'lang.label': 'Idioma',
      'country.label': 'País del documento',
      'country.help': 'País que emitió el documento. No cambia el idioma de la interfaz ni la moneda.',
      'country.currencyHint': 'Moneda esperada (orientativa): {currency}. La moneda real es la leída en el documento.',
      'status.SUPPORTED': 'Compatible',
      'status.BETA': 'Beta',
      'status.COMING_SOON': 'Próximamente',
      'status.BETA.notEnabled': 'Beta – próximamente disponible',
      'status.COMING_SOON.notEnabled': 'Próximamente disponible',
      'country.betaNotice': 'Soporte beta para {country}: aún sin verificar con benchmark. Revisa siempre los resultados.',
      'country.comingSoonNotice': '{country} aún no está disponible.'
    },
    pt: {
      'meta.title': 'InvoiceExtract – Extração de dados de faturas e recibos',
      'meta.description': 'Transforme faturas e recibos (PDF ou foto) em dados estruturados, com verificação matemática dos valores. Exporte para Excel ou CSV.',
      'lang.label': 'Idioma',
      'country.label': 'País do documento',
      'country.help': 'País que emitiu o documento. Não altera o idioma da interface nem a moeda.',
      'country.currencyHint': 'Moeda esperada (indicativa): {currency}. A moeda real é a lida no documento.',
      'status.SUPPORTED': 'Suportado',
      'status.BETA': 'Beta',
      'status.COMING_SOON': 'Em breve',
      'status.BETA.notEnabled': 'Beta – em breve disponível',
      'status.COMING_SOON.notEnabled': 'Em breve disponível',
      'country.betaNotice': 'Suporte beta para {country}: ainda não verificado por benchmark. Confira sempre os resultados.',
      'country.comingSoonNotice': '{country} ainda não está disponível.'
    }
  };

  function isSupportedLocale(code) {
    return typeof code === 'string' && SUPPORTED_LOCALES.indexOf(code.toLowerCase()) !== -1;
  }

  function isSeoExposed(code) {
    return typeof code === 'string' && SEO_EXPOSED_LOCALES.indexOf(code) !== -1;
  }

  function normalizeLocale(code) {
    if (typeof code !== 'string') return null;
    var base = code.trim().toLowerCase().split(/[-_]/)[0];
    return isSupportedLocale(base) ? base : null;
  }

  // Ordine: preferenza esplicita valida > default. Mai dedotta dal paese.
  function resolveLocale(candidate) {
    return normalizeLocale(candidate) || DEFAULT_LOCALE;
  }

  function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m;
    });
  }

  // Chiave mancante nel locale => fallback locale => la chiave stessa.
  function t(locale, key, params) {
    var loc = resolveLocale(locale);
    var dict = DICTIONARIES[loc] || {};
    var value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
    if (value === undefined) {
      var fb = DICTIONARIES[FALLBACK_LOCALE] || {};
      value = Object.prototype.hasOwnProperty.call(fb, key) ? fb[key] : key;
    }
    return interpolate(value, params);
  }

  // Prefisso di percorso localizzato: "/it/foo" -> "it"; altrimenti null.
  function localeFromPath(pathname) {
    var m = /^\/([a-z]{2})(?:\/|$)/i.exec(pathname || '');
    return m ? normalizeLocale(m[1]) : null;
  }

  return {
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    SEO_EXPOSED_LOCALES: SEO_EXPOSED_LOCALES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    FALLBACK_LOCALE: FALLBACK_LOCALE,
    LOCALE_NAMES: LOCALE_NAMES,
    OG_LOCALES: OG_LOCALES,
    DICTIONARIES: DICTIONARIES,
    isSupportedLocale: isSupportedLocale,
    isSeoExposed: isSeoExposed,
    normalizeLocale: normalizeLocale,
    resolveLocale: resolveLocale,
    localeFromPath: localeFromPath,
    t: t
  };
}));
