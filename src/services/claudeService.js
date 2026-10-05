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
1. Analizza il documento allegato (PDF o immagine, anche multipagina).
2. Estrai SOLO i dati realmente presenti e leggibili nel documento. Non inventare, stimare o "indovinare" MAI valori numerici o testuali: se un campo non è determinabile con certezza, lascialo vuoto/null.
3. Prima di rispondere, esegui tu stesso una verifica matematica esplicita: calcola subtotal + vat_amount e confrontalo con total, con una tolleranza massima di 0.01 per arrotondamenti.
   - Imposta math_verified = true SOLO se questa verifica è soddisfatta E hai sia subtotal che vat_amount che total leggibili.
   - Imposta math_verified = false in tutti gli altri casi (discrepanza, dato mancante, importo illeggibile).
4. Usa sempre il punto (.) come separatore decimale nei valori numerici restituiti, mai la virgola.
5. Se il documento contiene più aliquote IVA, riporta in vat_amount la somma totale dell'imposta e in vat_rate l'aliquota prevalente.
6. DOCUMENTI MULTIPLI NELLO STESSO FILE: se il documento fornito contiene PIÙ fatture o ricevute distinte (es. più pagine, ciascuna con un documento diverso), invoca lo strumento record_invoice_data UNA VOLTA PER CIASCUN documento distinto che identifichi, anche se questo significa invocarlo più volte nella stessa risposta. Se invece le pagine fanno parte dello stesso singolo documento (es. una fattura di più pagine con le righe di dettaglio proseguite su più fogli), trattale come un unico documento e invoca lo strumento una sola volta.
7. Non includere MAI testo libero, spiegazioni o commenti al di fuori delle chiamate allo strumento fornito.
8. Rispondi ESCLUSIVAMENTE invocando lo strumento "record_invoice_data" con i dati estratti, una volta per ciascun documento distinto individuato.`;

/**
 * Invia un singolo file (Buffer in memoria, mai su disco) a Claude e
 * restituisce un ARRAY di record contabili strutturati: uno per ciascun
 * documento distinto che Claude identifica nel file (un file può contenere
 * più fatture/ricevute, es. una scansione cumulativa multipagina).
 *
 * options.countryCode: paese del documento (ISO 3166-1 alpha-2, già validato
 * dalla route). Viene riportato su ogni record come `country_code`. Il
 * prompt/schema NON lo usano ancora: punto di integrazione futuro = il testo
 * utente della richiesta (sotto), per es. aggiungendo un suggerimento sul
 * paese, solo dopo un benchmark per paese. Non influenza la valuta.
 */
async function extractInvoiceData(fileBuffer, mimetype, filename, options = {}) {
  const countryCode = options && options.countryCode ? options.countryCode : null;
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
      // Alzato da 4096: con molti documenti nello stesso file (es. una
      // scansione cumulativa multipagina), Claude deve invocare lo
      // strumento una volta per documento nella stessa risposta, e il
      // budget precedente troncava silenziosamente i file più affollati
      // (osservato oltre ~16 documenti). Restiamo in modalità non
      // streaming, quindi non saliamo oltre questo valore per evitare
      // timeout HTTP lato client.
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL],
      // "any" forza comunque l'uso di uno strumento (mai testo libero), ma
      // senza il vincolo implicito di UNA sola chiamata che porta
      // {type: 'tool', name: ...}: l'uso parallelo dello stesso tool più
      // volte resta possibile ed è ciò che vogliamo per i documenti multipli.
      tool_choice: { type: 'any' },
      messages: [
        {
          role: 'user',
          content: [
            documentBlock,
            {
              type: 'text',
              text: 'Estrai i dati contabili strutturati da questo documento. Se contiene più fatture/ricevute distinte, invoca lo strumento una volta per ciascuna.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    // Non logghiamo mai il contenuto del documento, solo l'errore tecnico.
    console.error('[claudeService] error_code=PROVIDER_ERROR');
    throw Object.assign(new Error(`Estrazione fallita per "${filename}": errore del servizio IA.`), { status: 502 });
  }

  const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
  if (toolUseBlocks.length === 0) {
    throw Object.assign(new Error(`Impossibile estrarre dati strutturati da "${filename}".`), { status: 502 });
  }

  // "max_tokens" indica che la risposta è stata TRONCATA dal limite di
  // token in output prima che Claude finisse di elaborare il documento:
  // i tool_use raccolti finora sono comunque validi e li restituiamo,
  // ma segnaliamo esplicitamente l'incompletezza al chiamante invece di
  // trattarla come un successo silenzioso (un file con molti documenti
  // potrebbe averne persi alcuni in coda).
  const truncated = response.stop_reason === 'max_tokens';
  if (truncated) {
    console.error('[claudeService] error_code=EXTRACTION_INCOMPLETE');
  }

  const multipleDocuments = toolUseBlocks.length > 1;
  const records = toolUseBlocks.map((block, index) => ({
    ...block.input,
    source_file: multipleDocuments ? `${filename} (documento ${index + 1})` : filename,
    ...(countryCode ? { country_code: countryCode } : {}),
  }));

  return { records, truncated, extractedCount: toolUseBlocks.length };
}

module.exports = { extractInvoiceData };
