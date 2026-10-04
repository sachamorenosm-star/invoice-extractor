# Invoice & Receipt Data Extractor

Micro-SaaS B2B "a zero interazione umana" per l'estrazione automatica di dati
contabili da fatture e ricevute (PDF/immagini), tramite l'API di Claude
(Anthropic). Esportazione in Excel (.xlsx) o CSV con doppia verifica
matematica (IA + controllo programmatico indipendente).

## Caratteristiche principali

- Upload drag & drop di PDF multipagina e immagini (JPG/PNG/WEBP)
- **Elaborazione temporanea**: i file sono elaborati solo in memoria (RAM),
  mai scritti su disco dall'applicazione. Il trattamento e l'eventuale
  conservazione presso il fornitore IA sono soggetti ai suoi termini e privacy policy.
- Estrazione strutturata dei dati (fornitore, data, numero fattura,
  imponibile, IVA, totale, valuta, righe voci) tramite Claude
- **Doppia autoverifica dei calcoli**: flag `math_verified` calcolato
  dall'IA + verifica indipendente lato server (`mathVerifier.js`)
- Data grid di anteprima modificabile prima dell'export
- Export in Excel (.xlsx, con evidenziazione gialla delle righe con
  discrepanze) e CSV
- Abbonamento ricorrente 9,90€/mese via Stripe Checkout, con limiti di
  scansione mensili per piano Free vs Pro
- Sicurezza baseline: Helmet, rate limiting, validazione input, CORS

## Requisiti

- Node.js >= 18
- Una API Key Anthropic (https://console.anthropic.com/)
- Un account Stripe (per l'abbonamento)

## Installazione locale

```bash
cd invoice-extractor
npm install
cp .env.example .env
# Modifica .env con le tue chiavi reali
npm run dev
```

Il server parte su `http://localhost:3000`.

## Variabili d'ambiente

Vedi `.env.example` per l'elenco completo. Le più importanti:

| Variabile | Descrizione |
|---|---|
| `ANTHROPIC_API_KEY` | Chiave API Claude (obbligatoria) |
| `CLAUDE_MODEL` | Modello Claude da usare (es. `claude-3-5-sonnet-latest`) |
| `STRIPE_SECRET_KEY` | Chiave segreta Stripe |
| `STRIPE_WEBHOOK_SECRET` | Secret per verificare i webhook Stripe |
| `STRIPE_PRICE_ID` | ID del prezzo ricorrente (9,90€/mese) |
| `MAX_FILE_SIZE_MB` | Dimensione massima file caricabile |
| `FREE_PLAN_MONTHLY_SCANS` | Limite scansioni mensili piano gratuito |

## Struttura del progetto

```
invoice-extractor/
├── public/              # Frontend statico (HTML/Tailwind/JS vanilla)
│   ├── index.html
│   └── legal/           # Privacy Policy e Termini di Servizio
├── src/
│   ├── server.js        # Entry point Express
│   ├── routes/          # Endpoint API (extract, export, stripe)
│   ├── services/        # Logica di business (Claude, Excel, Stripe)
│   ├── middleware/       # Upload (memoryStorage), auth, error handling
│   └── utils/           # Verifica matematica, validatori
```

## Deploy in produzione

### Opzione A — Render (consigliata per questo stack Express "always-on")

1. Crea un account su [render.com](https://render.com) e collega il repository Git del progetto.
2. Crea un nuovo **Web Service**:
   - Build command: `npm install`
   - Start command: `npm start`
   - Runtime: Node
3. Nella sezione **Environment**, aggiungi tutte le variabili elencate in
   `.env.example` con i valori reali (vedi tabella sotto).
4. Deploya. Render fornirà un URL pubblico HTTPS (es. `https://invoice-extractor.onrender.com`).
5. Aggiorna `FRONTEND_URL`, `STRIPE_SUCCESS_URL` e `STRIPE_CANCEL_URL` con
   l'URL pubblico assegnato da Render.
6. Configura il webhook Stripe (vedi sotto) puntando a
   `https://<tuo-dominio>/api/stripe/webhook`.

### Opzione B — Vercel

Vercel esegue Express come funzioni serverless. Aggiungi un file
`vercel.json` nella root del progetto:

```json
{
  "version": 2,
  "builds": [{ "src": "src/server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "src/server.js" }]
}
```

Poi:

```bash
npm i -g vercel
vercel
vercel env add ANTHROPIC_API_KEY
vercel env add STRIPE_SECRET_KEY
# ... ripeti per tutte le variabili di .env.example
vercel --prod
```

> Nota: su Vercel le funzioni serverless hanno un limite di durata per
> richiesta; per l'elaborazione di molti file PDF di grandi dimensioni,
> Render (server always-on) è generalmente più adatto.

### Configurazione del webhook Stripe

1. Nella Dashboard Stripe, vai su **Developers → Webhooks → Add endpoint**.
2. URL endpoint: `https://<tuo-dominio>/api/stripe/webhook`.
3. Eventi da ascoltare:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copia il **Signing secret** generato e impostalo come `STRIPE_WEBHOOK_SECRET`.
5. Crea un prodotto ricorrente da 9,90€/mese nella Dashboard Stripe e copia
   l'ID del prezzo (`price_...`) in `STRIPE_PRICE_ID`.

### Variabili d'ambiente da configurare in produzione

| Variabile | Dove trovarla |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/) → API Keys |
| `CLAUDE_MODEL` | Nome del modello Claude da usare (es. `claude-3-5-sonnet-latest`) |
| `STRIPE_SECRET_KEY` | Dashboard Stripe → Developers → API keys |
| `STRIPE_PUBLISHABLE_KEY` | Dashboard Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Dashboard Stripe → Developers → Webhooks → il tuo endpoint |
| `STRIPE_PRICE_ID` | Dashboard Stripe → Product catalog → il tuo prodotto ricorrente |
| `FRONTEND_URL` | URL pubblico dell'app (per CORS) |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | URL pubblico + `/?checkout=success` o `=cancel` |
| `MAX_FILE_SIZE_MB`, `MAX_FILES_PER_REQUEST` | Limiti di upload (facoltativi, hanno default) |
| `FREE_PLAN_MONTHLY_SCANS`, `PRO_PLAN_MONTHLY_SCANS` | Limiti di scansione per piano |

## Note GDPR

Questa applicazione **non salva mai** i file caricati dagli utenti su
disco persistente. I file sono processati interamente in memoria
(`multer.memoryStorage()`), inviati all'API Anthropic per l'estrazione e
scartati immediatamente dopo la generazione della risposta. Consulta
`public/legal/privacy-policy.html` per i dettagli completi.
