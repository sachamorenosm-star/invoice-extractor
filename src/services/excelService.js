const ExcelJS = require('exceljs');
const { verifyInvoiceMath } = require('../utils/mathVerifier');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const WARNING_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9C3' } };
const OK_FONT = { color: { argb: 'FF15803D' }, bold: true };
const WARNING_FONT = { color: { argb: 'FFB45309' }, bold: true };

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£' };

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Formato numerico Excel con simbolo di valuta in coda (es. "1.234,56 €").
// La resa esatta di virgola/punto dipende dalle impostazioni regionali di
// chi apre il file, ma il simbolo di valuta è sempre mostrato.
function currencyNumFmt(currencyCode) {
  const symbol = CURRENCY_SYMBOLS[currencyCode] || currencyCode || '';
  return symbol ? `#,##0.00" ${symbol}"` : '#,##0.00';
}

function buildColumns(showCurrencyColumn, showSuggestionColumn) {
  const columns = [
    { header: 'File Origine', key: 'source_file', width: 26 },
    { header: 'Fornitore', key: 'supplier', width: 28 },
    { header: 'N. Fattura', key: 'invoice_number', width: 16 },
    { header: 'Data', key: 'date', width: 13 },
    { header: 'Imponibile', key: 'subtotal', width: 15 },
    { header: 'IVA', key: 'vat_amount', width: 13 },
    { header: 'Totale', key: 'total', width: 15 },
  ];
  if (showCurrencyColumn) {
    columns.push({ header: 'Valuta', key: 'currency', width: 10 });
  }
  columns.push({ header: 'Verifica Matematica', key: 'verification', width: 20 });
  if (showSuggestionColumn) {
    columns.push({ header: 'Suggerimento (da verificare)', key: 'suggestion', width: 46 });
  }
  return columns;
}

/**
 * Calcola un'IPOTESI di quale sarebbe il Totale "atteso" se Imponibile e IVA
 * fossero corretti così come inseriti. NON è una correzione: è solo un
 * suggerimento testuale per aiutare l'utente a capire cosa controllare sul
 * documento originale prima di modificare manualmente i dati.
 */
function computeMathSuggestion(row, currencyCode) {
  const sub = toNumberOrNull(row.subtotal);
  const vat = toNumberOrNull(row.vat_amount);
  const total = toNumberOrNull(row.total);

  if (sub === null || vat === null || total === null) return '';

  const expectedTotal = Math.round((sub + vat) * 100) / 100;
  if (Math.abs(expectedTotal - total) <= 0.01) return '';

  const symbol = CURRENCY_SYMBOLS[currencyCode] || currencyCode || '';
  const fmt = (n) => `${n.toFixed(2)}${symbol ? ' ' + symbol : ''}`;

  return `💡 Ipotesi: se il Totale fosse ${fmt(expectedTotal)} invece di ${fmt(total)}, i calcoli tornerebbero. Da verificare sul documento originale, non è una correzione automatica.`;
}

/**
 * Determina se tutte le righe condividono la stessa valuta. In tal caso
 * possiamo mostrarla una sola volta in una nota di riepilogo invece di
 * ripeterla identica in ogni riga, rendendo la tabella più leggibile.
 */
function detectSingleCurrency(rows) {
  const currencies = new Set(
    rows.map((r) => (r.currency || 'EUR').toUpperCase().trim()).filter(Boolean),
  );
  return currencies.size === 1 ? [...currencies][0] : null;
}

function applyBorderToRow(row, columnCount) {
  for (let i = 1; i <= columnCount; i += 1) {
    row.getCell(i).border = THIN_BORDER;
  }
}

/**
 * Aggiunge il foglio "Guida rapida": una spiegazione in linguaggio semplice
 * per utenti senza background contabile, con un esempio visivo della
 * evidenziazione gialla.
 */
function addGuideSheet(workbook) {
  const guide = workbook.addWorksheet('Guida rapida');
  guide.getColumn(1).width = 26;
  guide.getColumn(2).width = 80;

  let r = 1;

  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value = '📘 Guida rapida alla lettura del file';
  guide.getCell(r, 1).font = { size: 16, bold: true, color: { argb: 'FF4F46E5' } };
  r += 2;

  guide.getCell(r, 1).value = 'Cosa contiene questo file';
  guide.getCell(r, 1).font = { bold: true, size: 12 };
  r += 1;
  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value =
    'Ogni riga del foglio "Fatture Estratte" corrisponde a un documento (fattura o ricevuta) che hai caricato. I dati sono stati letti automaticamente da un\'intelligenza artificiale: controlla sempre i valori prima di usarli per la contabilità.';
  guide.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(r).height = 40;
  r += 2;

  guide.getCell(r, 1).value = 'Significato delle colonne';
  guide.getCell(r, 1).font = { bold: true, size: 12 };
  r += 1;

  const columnExplanations = [
    ['File Origine', 'Il nome del file PDF o immagine che hai caricato.'],
    ['Fornitore', "Chi ha emesso il documento (l'azienda o persona a cui hai pagato/devi pagare)."],
    ['N. Fattura', 'Il numero identificativo della fattura o ricevuta, come scritto sul documento.'],
    ['Data', "La data di emissione del documento."],
    ['Imponibile', "L'importo della spesa PRIMA delle tasse (IVA). È la base su cui viene calcolata l'imposta."],
    ['IVA', "L'importo dell'imposta sul valore aggiunto applicata al documento."],
    ['Totale', 'Imponibile + IVA: è la cifra totale effettivamente pagata o da pagare.'],
    ['Verifica Matematica', 'Un controllo automatico: vedi la sezione dedicata qui sotto.'],
  ];

  columnExplanations.forEach(([col, desc]) => {
    guide.getCell(r, 1).value = col;
    guide.getCell(r, 1).font = { bold: true };
    guide.getCell(r, 2).value = desc;
    guide.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
    r += 1;
  });
  r += 1;

  guide.getCell(r, 1).value = '"OK" e "Da verificare"';
  guide.getCell(r, 1).font = { bold: true, size: 12 };
  r += 1;
  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value =
    'La colonna "Verifica Matematica" controlla automaticamente se Imponibile + IVA = Totale (con una piccola tolleranza per gli arrotondamenti).';
  guide.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(r).height = 30;
  r += 1;

  guide.getCell(r, 1).value = '✓ OK';
  guide.getCell(r, 1).font = OK_FONT;
  guide.getCell(r, 2).value = 'I tre importi tornano: puoi fidarti dei dati estratti.';
  guide.getCell(r, 2).alignment = { wrapText: true };
  r += 1;

  guide.getCell(r, 1).value = '⚠ Da verificare';
  guide.getCell(r, 1).font = WARNING_FONT;
  guide.getCell(r, 2).value =
    "Imponibile + IVA non corrisponde al Totale: probabilmente l'IA ha letto male un numero, o il documento ha un calcolo particolare. Controlla il documento originale e correggi i valori.";
  guide.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(r).height = 40;
  r += 2;

  guide.getCell(r, 1).value = 'Colonna "Suggerimento"';
  guide.getCell(r, 1).font = { bold: true, size: 12 };
  r += 1;
  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value =
    'Per le righe "Da verificare" (se presenti), trovi anche una colonna "Suggerimento" con un\'IPOTESI di quale valore renderebbe corretto il calcolo (Imponibile + IVA = Totale). È solo un\'idea su cosa controllare: NON è mai una correzione applicata automaticamente. Verifica sempre sul documento originale prima di cambiare qualsiasi importo.';
  guide.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(r).height = 55;
  r += 2;

  guide.getCell(r, 1).value = 'Perché alcune righe sono gialle';
  guide.getCell(r, 1).font = { bold: true, size: 12 };
  r += 1;
  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value =
    'Nel foglio "Fatture Estratte", le righe con una discrepanza matematica (stato "Da verificare") sono evidenziate con uno sfondo giallo, come in questo esempio, per farle notare subito a colpo d\'occhio:';
  guide.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(r).height = 30;
  r += 1;

  // Esempio visivo di riga gialla
  guide.getCell(r, 1).value = 'Esempio S.r.l.';
  guide.getCell(r, 2).value = 'Totale: 122,00 € — ma Imponibile + IVA = 130,00 € ⚠ Da verificare';
  [1, 2].forEach((c) => {
    guide.getCell(r, c).fill = WARNING_FILL;
    guide.getCell(r, c).border = THIN_BORDER;
  });
  r += 2;

  guide.mergeCells(r, 1, r, 2);
  guide.getCell(r, 1).value =
    'Suggerimento: apri il foglio "Fatture Estratte" (scheda successiva) per vedere i dati completi.';
  guide.getCell(r, 1).font = { italic: true, color: { argb: 'FF64748B' } };
}

/**
 * Genera un file Excel (.xlsx) professionalmente formattato a partire dalle
 * righe estratte/modificate dall'utente. Le righe con discrepanze
 * matematiche (Imponibile + IVA != Totale) vengono evidenziate in giallo,
 * indipendentemente dal flag `math_verified` fornito dal client: viene
 * ricalcolato qui, lato server, un controllo indipendente definitivo.
 */
async function generateExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Invoice & Receipt Data Extractor';
  workbook.created = new Date();

  // Il foglio guida viene aggiunto per primo così è la prima scheda visibile
  // quando si apre il file.
  addGuideSheet(workbook);

  const singleCurrency = detectSingleCurrency(rows);
  const showCurrencyColumn = !singleCurrency;
  const showSuggestionColumn = rows.some((row) => !verifyInvoiceMath(row).verified);
  const columns = buildColumns(showCurrencyColumn, showSuggestionColumn);
  const columnCount = columns.length;

  const sheet = workbook.addWorksheet('Fatture Estratte', {
    views: [{ state: 'frozen', ySplit: 5 }],
  });
  sheet.columns = columns;

  // ---------------------------------------------------------------
  // Riepilogo in cima al foglio (sopra l'intestazione delle colonne)
  // ---------------------------------------------------------------
  let discrepancyCount = 0;
  let totalSubtotal = 0;
  let totalVat = 0;
  let totalGrand = 0;

  rows.forEach((row) => {
    const check = verifyInvoiceMath(row);
    if (!check.verified) discrepancyCount += 1;
    totalSubtotal += toNumberOrNull(row.subtotal) || 0;
    totalVat += toNumberOrNull(row.vat_amount) || 0;
    totalGrand += toNumberOrNull(row.total) || 0;
  });

  const moneyFmt = currencyNumFmt(singleCurrency || 'EUR');

  sheet.mergeCells(1, 1, 1, columnCount);
  sheet.getCell(1, 1).value = '📊 Riepilogo estrazione — Invoice & Receipt Data Extractor';
  sheet.getCell(1, 1).font = { size: 14, bold: true, color: { argb: 'FF4F46E5' } };

  sheet.getCell(2, 1).value = 'Documenti totali:';
  sheet.getCell(2, 1).font = { bold: true };
  sheet.getCell(2, 2).value = rows.length;
  sheet.getCell(2, 3).value = 'Da verificare:';
  sheet.getCell(2, 3).font = { bold: true };
  sheet.getCell(2, 4).value = discrepancyCount;
  sheet.getCell(2, 4).font = discrepancyCount > 0 ? WARNING_FONT : OK_FONT;
  sheet.getCell(2, 5).value = 'Valuta:';
  sheet.getCell(2, 5).font = { bold: true };
  sheet.getCell(2, 6).value = singleCurrency
    ? `${singleCurrency} (${CURRENCY_SYMBOLS[singleCurrency] || singleCurrency})`
    : 'Valute miste (vedi colonna Valuta)';

  sheet.getCell(3, 1).value = 'Totale Imponibile:';
  sheet.getCell(3, 1).font = { bold: true };
  sheet.getCell(3, 2).value = totalSubtotal;
  sheet.getCell(3, 2).numFmt = moneyFmt;
  sheet.getCell(3, 3).value = 'Totale IVA:';
  sheet.getCell(3, 3).font = { bold: true };
  sheet.getCell(3, 4).value = totalVat;
  sheet.getCell(3, 4).numFmt = moneyFmt;
  sheet.getCell(3, 5).value = 'Totale Complessivo:';
  sheet.getCell(3, 5).font = { bold: true };
  sheet.getCell(3, 6).value = totalGrand;
  sheet.getCell(3, 6).numFmt = moneyFmt;
  sheet.getCell(3, 6).font = { bold: true };

  // Riga vuota di separazione (riga 4), header colonne in riga 5
  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((col, i) => {
    headerRow.getCell(i + 1).value = col.header;
  });
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 22;

  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: columnCount },
  };

  // ---------------------------------------------------------------
  // Righe dati
  // ---------------------------------------------------------------
  rows.forEach((row) => {
    const check = verifyInvoiceMath(row);
    const rowValues = {
      source_file: row.source_file || '',
      supplier: row.supplier || '',
      invoice_number: row.invoice_number || '',
      date: row.date || '',
      subtotal: toNumberOrNull(row.subtotal),
      vat_amount: toNumberOrNull(row.vat_amount),
      total: toNumberOrNull(row.total),
      verification: check.verified ? '✓ OK' : '⚠ Da verificare',
    };
    if (showCurrencyColumn) {
      rowValues.currency = row.currency || '';
    }

    const rowCurrency = showCurrencyColumn ? (row.currency || 'EUR') : singleCurrency || 'EUR';

    if (showSuggestionColumn) {
      rowValues.suggestion = check.verified ? '' : computeMathSuggestion(row, rowCurrency);
    }

    const excelRow = sheet.addRow(rowValues);

    const rowMoneyFmt = currencyNumFmt(rowCurrency);
    ['subtotal', 'vat_amount', 'total'].forEach((key) => {
      excelRow.getCell(key).numFmt = rowMoneyFmt;
    });

    if (showSuggestionColumn) {
      excelRow.getCell('suggestion').alignment = { wrapText: true, vertical: 'top' };
      excelRow.getCell('suggestion').font = { italic: true, color: { argb: 'FF64748B' } };
    }

    applyBorderToRow(excelRow, columnCount);

    if (!check.verified) {
      excelRow.eachCell((cell) => {
        cell.fill = WARNING_FILL;
      });
      excelRow.getCell('verification').font = WARNING_FONT;
    } else {
      excelRow.getCell('verification').font = OK_FONT;
    }
  });

  // Nota finale di riepilogo discrepanze, se presenti
  if (discrepancyCount > 0) {
    const noteRow = sheet.addRow([]);
    noteRow.getCell(1).value =
      `⚠ ${discrepancyCount} documento/i con discrepanze tra Imponibile + IVA e Totale (evidenziati in giallo). Vedi il foglio "Guida rapida" per i dettagli.`;
    noteRow.getCell(1).font = { italic: true, color: { argb: 'FFB45309' } };
    sheet.mergeCells(noteRow.number, 1, noteRow.number, columnCount);
  }

  return workbook.xlsx.writeBuffer();
}

/**
 * Genera un CSV (senza formattazione/colori, il CSV non li supporta) a
 * partire dalle stesse righe, con una riga di commento iniziale che spiega
 * il contenuto del file per chi non ha familiarità con la contabilità.
 * Il BOM UTF-8 iniziale (﻿, applicato da chi chiama questa funzione)
 * è già sufficiente per far riconoscere correttamente gli accenti a Excel
 * e LibreOffice: non serve altro.
 */
function generateCsv(rows) {
  const singleCurrency = detectSingleCurrency(rows);
  const showCurrencyColumn = !singleCurrency;
  const showSuggestionColumn = rows.some((row) => !verifyInvoiceMath(row).verified);

  const headers = ['File Origine', 'Fornitore', 'N. Fattura', 'Data', 'Imponibile', 'IVA', 'Totale'];
  if (showCurrencyColumn) headers.push('Valuta');
  headers.push('Verifica Matematica');
  if (showSuggestionColumn) headers.push('Suggerimento (da verificare)');

  const currencyNote = singleCurrency
    ? `Tutti gli importi sono in ${singleCurrency} (${CURRENCY_SYMBOLS[singleCurrency] || singleCurrency}).`
    : 'Attenzione: i documenti usano valute diverse, vedi la colonna Valuta.';

  const suggestionNote = showSuggestionColumn
    ? ' La colonna "Suggerimento" propone solo un\'ipotesi di calcolo da verificare sul documento originale: non è mai una correzione automatica.'
    : '';

  const commentLine =
    `# Dati contabili estratti automaticamente da fatture/ricevute. ${currencyNote} ` +
    'La colonna "Verifica Matematica" indica "OK" se Imponibile + IVA = Totale, oppure "Da verificare" in caso di discrepanza da controllare manualmente.' +
    suggestionNote;

  const lines = [commentLine, headers.join(',')];

  rows.forEach((row) => {
    const check = verifyInvoiceMath(row);
    const rowCurrency = row.currency || singleCurrency || 'EUR';
    const values = [
      row.source_file,
      row.supplier,
      row.invoice_number,
      row.date,
      toNumberOrNull(row.subtotal),
      toNumberOrNull(row.vat_amount),
      toNumberOrNull(row.total),
    ];
    if (showCurrencyColumn) values.push(row.currency);
    values.push(check.verified ? 'OK' : 'Da verificare');
    if (showSuggestionColumn) {
      values.push(check.verified ? '' : computeMathSuggestion(row, rowCurrency));
    }

    lines.push(values.map(csvEscape).join(','));
  });

  return lines.join('\r\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = { generateExcelBuffer, generateCsv };
