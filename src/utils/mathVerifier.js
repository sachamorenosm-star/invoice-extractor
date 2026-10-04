// Verifica programmatica indipendente dei calcoli estratti.
//
// IMPORTANTE: questo controllo NON si fida del flag `math_verified` restituito
// dall'IA. Ricalcola autonomamente Imponibile + IVA e lo confronta con il
// Totale dichiarato, applicando una tolleranza per arrotondamenti.

const TOLERANCE = 0.01;

function toNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Verifica che subtotal + vat_amount === total entro una tolleranza.
 * Ritorna { verified, difference } dove `verified` è false anche quando
 * mancano dati sufficienti per calcolare (in tal caso non possiamo
 * confermare la correttezza, quindi trattiamo come non verificato).
 */
function verifyInvoiceMath(invoiceData) {
  const subtotal = toNumber(invoiceData.subtotal);
  const vat = toNumber(invoiceData.vat_amount);
  const total = toNumber(invoiceData.total);

  if (!Number.isFinite(subtotal) || !Number.isFinite(vat) || !Number.isFinite(total)) {
    return { verified: false, difference: null, reason: 'missing_values' };
  }

  const difference = Math.round((subtotal + vat - total) * 100) / 100;
  const verified = Math.abs(difference) <= TOLERANCE;

  return { verified, difference, reason: verified ? null : 'mismatch' };
}

/**
 * Applica la verifica indipendente a un intero risultato di estrazione
 * (che include già il flag `math_verified` restituito dall'IA) e imposta
 * il flag definitivo `math_verified` come AND logico tra le due verifiche:
 * il documento è considerato verificato solo se sia l'IA sia il controllo
 * di codice concordano.
 */
function applyIndependentVerification(extractedData) {
  const codeCheck = verifyInvoiceMath(extractedData);
  const aiSaysVerified = extractedData.math_verified === true;

  return {
    ...extractedData,
    math_verified: aiSaysVerified && codeCheck.verified,
    _verification: {
      ai_verified: aiSaysVerified,
      code_verified: codeCheck.verified,
      difference: codeCheck.difference,
    },
  };
}

module.exports = { verifyInvoiceMath, applyIndependentVerification, toNumber };
