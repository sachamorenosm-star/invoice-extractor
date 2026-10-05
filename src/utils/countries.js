// Configurazione centralizzata dei paesi del documento.
//
// Tre concetti INDIPENDENTI (non vanno mai dedotti l'uno dall'altro):
//   - lingua UI            -> public/i18n.js
//   - paese del documento  -> questo file (country_code)
//   - valuta               -> dato del documento (record.currency)
//
// defaultCurrency è solo un'aspettativa di contesto/fallback di visualizzazione:
// NON è la verità sul documento e NON implica il paese (EUR != paese UE).
// Nessuna logica fiscale normativa è codificata qui.

const SUPPORT_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',       // benchmarkato, comportamento di riferimento
  BETA: 'BETA',                 // utilizzabile, NON benchmarkato: verificare i risultati
  COMING_SOON: 'COMING_SOON',   // non selezionabile
});

const DEFAULT_COUNTRY_CODE = 'IT';

const COUNTRIES = Object.freeze({
  IT: { code: 'IT', displayName: 'Italia', defaultLocale: 'it', defaultCurrency: 'EUR', taxLabel: 'IVA', supportStatus: SUPPORT_STATUS.SUPPORTED },
  FR: { code: 'FR', displayName: 'France', defaultLocale: 'fr', defaultCurrency: 'EUR', taxLabel: 'TVA', supportStatus: SUPPORT_STATUS.BETA },
  DE: { code: 'DE', displayName: 'Deutschland', defaultLocale: 'de', defaultCurrency: 'EUR', taxLabel: 'MwSt', supportStatus: SUPPORT_STATUS.BETA },
  ES: { code: 'ES', displayName: 'España', defaultLocale: 'es', defaultCurrency: 'EUR', taxLabel: 'IVA', supportStatus: SUPPORT_STATUS.BETA },
  PT: { code: 'PT', displayName: 'Portugal', defaultLocale: 'pt', defaultCurrency: 'EUR', taxLabel: 'IVA', supportStatus: SUPPORT_STATUS.BETA },
  // Il modello di estrazione attuale (una sola aliquota/imposta) non
  // rappresenta la sales tax USA: resta COMING_SOON finché non c'è un benchmark.
  US: { code: 'US', displayName: 'United States', defaultLocale: 'en', defaultCurrency: 'USD', taxLabel: 'Sales Tax', supportStatus: SUPPORT_STATUS.COMING_SOON },
});

function normalizeCountryCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function getCountry(code) {
  const normalized = normalizeCountryCode(code);
  return Object.prototype.hasOwnProperty.call(COUNTRIES, normalized) ? COUNTRIES[normalized] : null;
}

function isKnownCountry(code) {
  return getCountry(code) !== null;
}

// Il paese è utilizzabile per l'estrazione solo se SUPPORTED o BETA.
function isCountrySelectable(code) {
  const country = getCountry(code);
  return !!country && country.supportStatus !== SUPPORT_STATUS.COMING_SOON;
}

// Solo SUPPORTED può essere presentato come pienamente supportato.
function isFullySupported(code) {
  const country = getCountry(code);
  return !!country && country.supportStatus === SUPPORT_STATUS.SUPPORTED;
}

// Valuta attesa di contesto. Mai usare come valuta del documento.
function getExpectedCurrency(code) {
  const country = getCountry(code);
  return country ? country.defaultCurrency : null;
}

// Risolve il country_code di una richiesta di estrazione.
// Assente => DEFAULT_COUNTRY_CODE (compatibilità con i client esistenti).
// Ritorna { ok, countryCode } oppure { ok:false, status, code, error }.
function resolveRequestCountry(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, countryCode: DEFAULT_COUNTRY_CODE };
  }
  const country = getCountry(raw);
  if (!country) {
    return { ok: false, status: 400, code: 'INVALID_COUNTRY_CODE', error: 'Paese del documento non valido.' };
  }
  if (country.supportStatus === SUPPORT_STATUS.COMING_SOON) {
    return { ok: false, status: 400, code: 'COUNTRY_NOT_AVAILABLE', error: 'Paese del documento non ancora disponibile.' };
  }
  return { ok: true, countryCode: country.code };
}

// Vista pubblica (nessun dato sensibile) per /api/config.
function listCountries() {
  return Object.values(COUNTRIES).map((c) => ({ ...c }));
}

module.exports = {
  SUPPORT_STATUS,
  DEFAULT_COUNTRY_CODE,
  COUNTRIES,
  normalizeCountryCode,
  getCountry,
  isKnownCountry,
  isCountrySelectable,
  isFullySupported,
  getExpectedCurrency,
  resolveRequestCountry,
  listCountries,
};
