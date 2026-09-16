const { canScan, getPlanStatus } = require('../services/stripeService');

const USER_ID_PATTERN = /^usr_[a-zA-Z0-9-]{8,64}$/;

// Identifica l'utente anonimo tramite l'header X-User-Id (generato lato
// client e salvato in localStorage). Non è un vero sistema di autenticazione
// con credenziali: serve solo a far rispettare i limiti di piano free/pro.
function identifyUser(req, res, next) {
  const headerId = req.get('X-User-Id');
  if (headerId && USER_ID_PATTERN.test(headerId)) {
    req.userId = headerId;
  } else {
    req.userId = null;
  }
  next();
}

// Applica il limite di pagine mensili in base al piano dell'utente.
// Se l'utente non è identificato, viene trattato come piano free anonimo
// condiviso (limite più basso) per evitare abusi senza header.
//
// `countFn` può essere un numero fisso oppure una funzione (anche async)
// che calcola il conteggio a partire da `req` — usato per contare le
// pagine REALI dei PDF caricati prima di consumare crediti API. Il
// risultato viene esposto su `req.scanCount` per essere riusato dal
// route handler successivo, evitando di ricalcolarlo due volte.
function enforceScanLimit(countFn = 1) {
  return async (req, res, next) => {
    try {
      const userId = req.userId || 'anonymous-shared';
      const count = typeof countFn === 'function' ? await countFn(req) : countFn;
      req.scanCount = count;

      if (!canScan(userId, count)) {
        const plan = getPlanStatus(userId);
        const remaining = Math.max(plan.limit - plan.used, 0);
        const limitDescription = plan.tier === 'studio'
          ? 'la soglia di fair-use del piano Studio'
          : `il limite di ${remaining} pagine rimaste questo mese (piano ${plan.tier})`;

        return res.status(429).json({
          error: `Questo caricamento contiene ${count} pagina/e: superi ${limitDescription}.`,
          plan,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { identifyUser, enforceScanLimit };
