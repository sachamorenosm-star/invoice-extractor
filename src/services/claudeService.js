const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// Lo strumento (tool) forza Claude a rispondere con un JSON strutturato e
// tipizzato, invece di testo libero da fare il parsing manualmente: molto
// più affidabile per un'estrazione dati "zero interazione umana".
const EXTRACTION_TOOL = {
  name: 'record_invoice_data',
  description: 'Registra i dati contabili strutturati estratti da una fattura o ricevuta.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: {
        type: 'string',
        description: 'Nome del fornitore/venditore che ha emesso il documento',
      },
      invoice_number: {
        type: 'string',
        description: 'Numero della fattura o ricevuta',
      },
      date: {
        type: 'string',
        description: 'Data di emissione del documento, in formato YYYY-MM-DD se determinabile',
      },
      subtotal: {
        type: 'number',
        description: 'Imponibile: importo totale prima delle imposte',
      },
      vat_amount: {
        type: 'number',
        description: "Importo totale dell'IVA/imposta applicata",
      },
      vat_rate: {
        type: 'number',
        description: 'Aliquota IVA principale applicata, in percentuale (es. 22 per 22%)',
      },
      total: {
        type: 'number',
        description: 'Totale documento (imponibile + IVA)',
      },
      currency: {
        type: 'string',
        description: 'Codice valuta ISO a 3 lettere (es. EUR, USD, GBP)',
      },
      line_items: {
        type: 'array',
        description: 'Righe/voci di dettaglio del documento, se presenti e leggibili',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unit_price: { type: 'number' },
            amount: { type: 'number' },
          },
        },
      },
      math_verified: {
        type: 'boolean',
        description:
          'true SOLO se hai verificato esplicitamente che subtotal + vat_amount sia matematicamente uguale a total (tolleranza massima di arrotondamento 0.01); false in ogni altro caso, inclusi dati mancanti o illeggibili.',
      },
      notes: {
        type: 'string',
        description: 'Eventuali osservazioni, es. documento parzialmente illeggibile o dati ambigui',
      },
    },
    required: ['supplier', 'total', 'currency', 'math_verified'],
  },
};

const SYSTEM_PROMPT = `Sei un motore di estrazione dati contabili estremamente preciso e affidabile, usato in un sistema automatizzato "zero interazione umana" per la contabilità di piccole imprese e freelance.

ISTRUZIONI CRITICHE (da seguire senza eccezioni):
1. Analizza esclusivamente il documento allegato (fattura o ricevuta, in formato PDF o immagine).
2. Estrai SOLO i dati realmente presenti e leggibili nel documento. Non inventare, stimare o "indovinare" MAI valori numerici o testuali: se un campo non è determinabile con certezza, lascialo vuoto/null.
3. Prima di rispondere, esegui tu stesso una verifica matematica esplicita: calcola subtotal + vat_amount e confrontalo con total, con una tolleranza massima di 0.01 per arrotondamenti.
   - Imposta math_verified = true SOLO se questa verifica è soddisfatta E hai sia subtotal che vat_amount che total leggibili.
   - Imposta math_verified = false in tutti gli altri casi (discrepanza, dato mancante, importo illeggibile).
4. Usa sempre il punto (.) come separatore decimale nei valori numerici restituiti, mai la virgola.
5. Se il documento contiene più aliquote IVA, riporta in vat_amount la somma totale dell'imposta e in vat_rate l'aliquota prevalente.
6. Non includere MAI testo libero, spiegazioni o commenti al di fuori della chiamata allo strumento fornito.
7. Rispondi ESCLUSIVAMENTE invocando lo strumento "record_invoice_data" con i dati estratti.`;

/**
 * Invia un singolo file (Buffer in memoria, mai su disco) a Claude e
 * restituisce i dati contabili strutturati estratti.
 */
async function extractInvoiceData(fileBuffer, mimetype, filename) {
  if (!anthropic) {
    throw Object.assign(new Error('Chiave API Anthropic non configurata sul server.'), { status: 500 });
  }

  const base64Data = fileBuffer.toString('base64');
  const isPdf = mimetype === 'application/pdf';

  // Supporto PDF via content block "document" (base64): nessun header beta
  // richiesto, è una funzionalità GA dell'API Messages.
  const documentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64Data } };

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_invoice_data' },
      messages: [
        {
          role: 'user',
          content: [
            documentBlock,
            { type: 'text', text: 'Estrai i dati contabili strutturati da questo documento.' },
          ],
        },
      ],
    });
  } catch (err) {
    // Non logghiamo mai il contenuto del documento, solo l'errore tecnico.
    console.error(`[claudeService] Errore API Anthropic per file "${filename}":`, err.message);
    throw Object.assign(new Error(`Estrazione fallita per "${filename}": errore del servizio IA.`), { status: 502 });
  }

  const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
  if (!toolUseBlock) {
    throw Object.assign(new Error(`Impossibile estrarre dati strutturati da "${filename}".`), { status: 502 });
  }

  return { ...toolUseBlock.input, source_file: filename };
}

module.exports = { extractInvoiceData };
