const multer = require('multer');

function notFoundHandler(req, res, next) {
  res.status(404).json({ error: 'Risorsa non trovata.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Uno dei file supera la dimensione massima consentita.',
      LIMIT_FILE_COUNT: 'Hai superato il numero massimo di file per richiesta.',
      LIMIT_UNEXPECTED_FILE: 'Campo file non atteso nella richiesta.',
    };
    return res.status(400).json({ error: messages[err.code] || 'Errore durante il caricamento del file.' });
  }

  if (err && err.message && err.message.startsWith('Tipo di file non supportato')) {
    return res.status(400).json({ error: err.message });
  }

  // Non logghiamo mai il body/payload della richiesta: potrebbe contenere
  // dati sensibili estratti dalle fatture. Logghiamo solo messaggio e stack.
  console.error('[ERROR]', err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Errore interno del server.' : err.message,
  });
}

module.exports = { errorHandler, notFoundHandler };
