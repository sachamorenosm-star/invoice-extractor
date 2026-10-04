// Messaggi utente, stati OK / CHECK / UNREADABLE e controlli sui file in ingresso.
// Funzioni pure (nessun DOM): usate da app.js nel browser e dai test in Node.
(function (root) {
  'use strict';

  // Campi chiave: se mancano, la riga va controllata. Nessuna "confidenza" in percentuale.
  const KEY_FIELDS = [
    ['supplier', 'fornitore'],
    ['invoice_number', 'numero fattura'],
    ['date', 'data'],
    ['currency', 'valuta'],
  ];
  // Un'immagine grezza oltre questo peso non viene nemmeno decodificata (memoria dei telefoni);
  // sotto, viene ridimensionata e ricodificata prima dell'upload.
  const RAW_IMAGE_CAP_MB = 25;

  const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';
  const isHeic = (file) => /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');

  const MESSAGES = {
    unsupported: (name, file) => (file && isHeic(file)
      ? `"${name}": le foto HEIC non sono supportate. Su iPhone imposta la fotocamera su «Più compatibile» (JPEG) oppure scegli un JPG.`
      : `"${name}": formato non supportato. Usa un PDF oppure una foto JPG, PNG o WEBP.`),
    fileTooLarge: (name, mb) => `"${name}": il file supera il limite di ${mb} MB. Usa un file più leggero.`,
    imageTooHeavy: (name, mb) => `"${name}": la foto è troppo pesante anche dopo la riduzione (limite ${mb} MB). Riprova con una foto meno dettagliata.`,
    rawImageTooLarge: (name) => `"${name}": la foto è troppo grande per essere elaborata. Scattane una a risoluzione più bassa.`,
    tooMany: (max) => `Puoi caricare al massimo ${max} file alla volta. Rimuovi un file o analizza prima quelli già in coda.`,
    decode: (name) => `"${name}": l'immagine non può essere letta (il file potrebbe essere danneggiato). Scattala di nuovo o scegli un'altra foto.`,
    resolutionTooLow: (name) => `"${name}": la foto è troppo piccola per leggere il testo. Avvicinati al documento o scegli una foto più grande.`,
    lowResolutionWarning: 'Risoluzione bassa: il testo potrebbe non essere leggibile. Consigliamo di rifare la foto.',
  };

  // Esito della classificazione di un file in ingresso, prima di qualunque decodifica.
  function classifyFile(file, limits, acceptedTypes) {
    if (!acceptedTypes.includes(file.type)) return { rejected: true, message: MESSAGES.unsupported(file.name, file) };
    if (file.type === 'application/pdf') {
      if (file.size > limits.maxFileSizeMb * 1024 * 1024) return { rejected: true, message: MESSAGES.fileTooLarge(file.name, limits.maxFileSizeMb) };
      return { rejected: false, kind: 'pdf' };
    }
    if (file.size > RAW_IMAGE_CAP_MB * 1024 * 1024) return { rejected: true, message: MESSAGES.rawImageTooLarge(file.name) };
    return { rejected: false, kind: 'image' };
  }

  // Messaggio sicuro per una riga fallita: mai errori del provider, stack o codici interni.
  function rowFailureMessage(row) {
    if (row.error_code === 'PDF_UNPARSEABLE') {
      return 'Non siamo riusciti a leggere questo documento. Prova con un file diverso o una foto più nitida.';
    }
    if (row.error_code === 'MAX_PAGES_PER_FILE_EXCEEDED') {
      const match = /(\d+) pagine/.exec(row.error || '');
      return match
        ? `Il documento ha troppe pagine: il limite è ${match[1]} pagine per file. Dividilo in file più piccoli.`
        : 'Il documento ha troppe pagine. Dividilo in file più piccoli.';
    }
    if (/servizio IA|non configurata/i.test(row.error || '')) {
      return 'Il servizio di analisi è temporaneamente non disponibile. Riprova tra poco.';
    }
    return 'Non siamo riusciti ad analizzare questo documento.';
  }

  // OK / CHECK / UNREADABLE dalla sola riga estratta: errore, campi chiave, verifica matematica.
  // `isMathValid(row)` è la verifica già presente nel frontend (app.js).
  function rowQuality(row, isMathValid) {
    if (row.error || row.error_code) {
      return { state: 'UNREADABLE', reasons: [], message: rowFailureMessage(row) };
    }
    const reasons = [];
    const missing = KEY_FIELDS.filter(([field]) => isBlank(row[field])).map(([, label]) => label);
    if (missing.length) reasons.push(`Mancano: ${missing.join(', ')}.`);
    if (!isMathValid(row)) reasons.push('Imponibile + IVA non corrispondono al totale (o un importo manca).');
    for (const note of row._clientNotes || []) reasons.push(note);
    return { state: reasons.length ? 'CHECK' : 'OK', reasons, message: reasons.join(' ') };
  }

  // Esito complessivo per il toast finale: non dice "completata" se tutto è fallito.
  function summarizeExtraction(rows, isMathValid) {
    const states = (rows || []).map((row) => rowQuality(row, isMathValid).state);
    if (!states.length || states.every((state) => state === 'UNREADABLE')) {
      return { kind: 'failed', message: 'Non è stato possibile analizzare i documenti.', isError: true };
    }
    if (states.every((state) => state === 'OK')) {
      return { kind: 'success', message: 'Estrazione completata.', isError: false };
    }
    return { kind: 'partial', message: 'Estrazione completata con alcuni documenti da verificare.', isError: false };
  }

  const api = { KEY_FIELDS, RAW_IMAGE_CAP_MB, MESSAGES, classifyFile, rowFailureMessage, rowQuality, summarizeExtraction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UploadQuality = api;
})(typeof self !== 'undefined' ? self : globalThis);
