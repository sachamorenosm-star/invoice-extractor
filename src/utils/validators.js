// Validatori di input condivisi tra le rotte API.

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

// Valida il payload inviato dal frontend per la generazione degli export
// (Excel/CSV): un array di righe con al massimo i campi attesi. Non ci
// fidiamo ciecamente del client: sanitizziamo i tipi prima di passare i
// dati a exceljs.
function sanitizeExportRows(rows) {
  if (!isNonEmptyArray(rows)) {
    throw Object.assign(new Error('Nessun dato da esportare.'), { status: 400 });
  }
  if (rows.length > 500) {
    throw Object.assign(new Error('Troppe righe da esportare (massimo 500).'), { status: 400 });
  }

  return rows.map((row) => ({
    source_file: sanitizeString(row.source_file),
    supplier: sanitizeString(row.supplier),
    invoice_number: sanitizeString(row.invoice_number),
    date: sanitizeString(row.date),
    subtotal: sanitizeNumber(row.subtotal),
    vat_amount: sanitizeNumber(row.vat_amount),
    total: sanitizeNumber(row.total),
    currency: sanitizeString(row.currency) || 'EUR',
    math_verified: row.math_verified === true,
  }));
}

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, 500);
}

function sanitizeNumber(value) {
  const num = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : 0;
}

const ALLOWED_EXPORT_FORMATS = ['xlsx', 'csv'];

function isValidExportFormat(format) {
  return ALLOWED_EXPORT_FORMATS.includes(format);
}

module.exports = {
  isNonEmptyArray,
  sanitizeExportRows,
  isValidExportFormat,
};
