/* Stato internazionale lato client (browser + Node, senza dipendenze).
 *
 * Lingua UI e paese del documento sono DUE preferenze indipendenti: cambiare
 * l'una non tocca mai l'altra, e nessuna delle due viene dedotta dall'IP,
 * dalla valuta o dall'altra. La valuta non vive qui: resta un dato del
 * documento (il paese espone solo una valuta "attesa" indicativa).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n'));
  else root.IntlState = factory(root.I18n);
}(typeof self !== 'undefined' ? self : this, function (I18n) {
  'use strict';

  var LANG_KEY = 'ie_lang';
  var COUNTRY_KEY = 'ie_country';

  function safeGet(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (e) { /* non bloccante */ }
  }

  function createIntlState(opts) {
    var storage = opts.storage || null;
    var countries = opts.countries || [];
    var defaultCountryCode = opts.defaultCountryCode || 'IT';
    var byCode = {};
    countries.forEach(function (c) { byCode[c.code] = c; });

    function selectable(code) {
      var c = byCode[code];
      return !!c && c.enabledForExtraction === true;
    }

    // Lingua: URL localizzato > preferenza salvata > default. Mai dal paese.
    var locale = I18n.localeFromPath(opts.pathname || '') ||
      I18n.normalizeLocale(safeGet(storage, LANG_KEY)) ||
      I18n.DEFAULT_LOCALE;

    // Paese: preferenza salvata (se ancora selezionabile) > default. Mai dalla lingua.
    var storedCountry = String(safeGet(storage, COUNTRY_KEY) || '').toUpperCase();
    var country = selectable(storedCountry) ? storedCountry : defaultCountryCode;

    return {
      getLocale: function () { return locale; },
      getCountry: function () { return country; },

      setLocale: function (code) {
        var next = I18n.normalizeLocale(code);
        if (!next) return false;
        locale = next;
        safeSet(storage, LANG_KEY, next);
        return true;
      },

      setCountry: function (code) {
        var next = String(code || '').toUpperCase();
        if (!selectable(next)) return false;
        country = next;
        safeSet(storage, COUNTRY_KEY, next);
        return true;
      },

      t: function (key, params) { return I18n.t(locale, key, params); },

      // Valuta ATTESA di contesto per il paese scelto: solo un suggerimento.
      getExpectedCurrency: function () {
        return byCode[country] ? byCode[country].defaultCurrency : null;
      },

      getCountryStatus: function () {
        return byCode[country] ? byCode[country].supportStatus : null;
      },

      getCountryOptions: function () {
        return countries.map(function (c) {
          return {
            code: c.code,
            status: c.supportStatus,
            enabled: c.enabledForExtraction === true,
            disabled: c.enabledForExtraction !== true,
            label: c.displayName + ' — ' + I18n.t(locale, c.enabledForExtraction === true ? 'status.' + c.supportStatus : 'status.' + c.supportStatus + '.notEnabled')
          };
        });
      }
    };
  }

  return { createIntlState: createIntlState, LANG_KEY: LANG_KEY, COUNTRY_KEY: COUNTRY_KEY };
}));
