// Ingresso immagini: decodifica reale, controllo risoluzione, ricodifica JPEG (orientamento applicato,
// metadati/EXIF eliminati perché il file inviato è sempre un'immagine NUOVA uscita dal canvas),
// e flusso anteprima "Usa foto / Rifai". Nessun DOM qui: le dipendenze del browser sono iniettate,
// così la logica è verificabile in Node. Non tratta i PDF.
(function (root) {
  'use strict';

  const Quality = typeof module === 'object' && module.exports ? require('./uploadQuality') : root.UploadQuality;
  const MESSAGES = Quality.MESSAGES;

  // Soglie iniziali, volutamente basse e facili da cambiare. Non garantiscono la qualità dell'OCR.
  const THRESHOLDS = Object.freeze({
    hardMinLongEdge: 500,   // lato lungo sotto questo valore: foto rifiutata
    hardMinShortEdge: 200,  // lato corto sotto questo valore: rifiutata (sotto i 200 px il provider è inaffidabile)
    warnMinLongEdge: 1000,  // lato lungo sotto questo valore: accettata ma da verificare (CHECK)
    maxLongEdge: 2000,      // oltre, si riduce: il provider ridimensiona comunque intorno a 1568-2576 px
    jpegQualities: [0.9, 0.85, 0.8, 0.75, 0.7], // mai sotto 0.7: il testo delle fatture va preservato
    shrinkStep: 0.85,       // riduzione del lato lungo se il file supera ancora il limite del server
    minLongEdgeAfterShrink: 1200,
  });

  function browserDeps() {
    return {
      createImageBitmap: typeof createImageBitmap === 'function' ? (...args) => createImageBitmap(...args) : null,
      createCanvas: (width, height) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      canvasToBlob: (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
      File,
      now: () => Date.now(),
    };
  }

  async function decodeImage(file, deps) {
    if (typeof deps.createImageBitmap !== 'function') throw new Error('decode');
    try {
      // 'from-image': l'orientamento EXIF viene applicato ai pixel come lo mostra il browser.
      return await deps.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      if (error && error.name === 'TypeError') {
        // Browser che non conoscono l'opzione: stessa decodifica senza opzioni.
        try { return await deps.createImageBitmap(file); } catch (_) { /* decodifica fallita */ }
      }
      throw new Error('decode');
    }
  }

  const closeBitmap = (bitmap) => { try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) { /* già chiusa */ } };
  const toJpegName = (name) => `${(name || 'foto').replace(/\.[^.]*$/, '') || 'foto'}.jpg`;

  // Esito: { ok:true, file, bitmap, width, height, quality:{level,reasons} }
  //     o  { ok:false, reason:'decode' | 'resolution' | 'toolarge' }
  async function prepareImage(file, limits, deps = browserDeps()) {
    let bitmap;
    try { bitmap = await decodeImage(file, deps); } catch (_) { return { ok: false, reason: 'decode' }; }
    const width = bitmap.width;
    const height = bitmap.height;
    if (!(width > 0 && height > 0)) { closeBitmap(bitmap); return { ok: false, reason: 'decode' }; }

    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    if (longEdge < THRESHOLDS.hardMinLongEdge || shortEdge < THRESHOLDS.hardMinShortEdge) {
      closeBitmap(bitmap);
      return { ok: false, reason: 'resolution' };
    }
    const reasons = longEdge < THRESHOLDS.warnMinLongEdge ? [MESSAGES.lowResolutionWarning] : [];

    const maxBytes = limits.maxFileSizeMb * 1024 * 1024;
    let scale = Math.min(1, THRESHOLDS.maxLongEdge / longEdge);
    for (let round = 0; round < 6; round++) {
      const outWidth = Math.max(1, Math.round(width * scale));
      const outHeight = Math.max(1, Math.round(height * scale));
      const canvas = deps.createCanvas(outWidth, outHeight);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; // il JPEG non ha trasparenza
      context.fillRect(0, 0, outWidth, outHeight);
      context.drawImage(bitmap, 0, 0, outWidth, outHeight);
      for (const quality of THRESHOLDS.jpegQualities) {
        const blob = await deps.canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) { closeBitmap(bitmap); return { ok: false, reason: 'decode' }; }
        if (blob.size <= maxBytes) {
          const out = new deps.File([blob], toJpegName(file.name), { type: 'image/jpeg', lastModified: deps.now() });
          return { ok: true, file: out, bitmap, width: outWidth, height: outHeight, quality: { level: reasons.length ? 'check' : 'ok', reasons } };
        }
      }
      if (Math.max(outWidth, outHeight) * THRESHOLDS.shrinkStep < THRESHOLDS.minLongEdgeAfterShrink) break;
      scale *= THRESHOLDS.shrinkStep;
    }
    closeBitmap(bitmap);
    return { ok: false, reason: 'toolarge' };
  }

  // Controller dell'ingresso file: validazione, preparazione, anteprima e coda.
  // handlers: getLimits, getQueueSize, addFile(file, quality|null), showPreview(item), hidePreview(),
  //           showErrors(messages[]), reopenPicker(source)
  function createIntake(options) {
    const deps = options.deps || browserDeps();
    const previews = [];
    let current = null;
    let chain = Promise.resolve();

    const used = () => options.getQueueSize() + previews.length + (current ? 1 : 0);

    function showNext() {
      current = previews.shift() || null;
      if (current) options.showPreview(current);
      else options.hidePreview();
    }

    async function process(files, source) {
      const limits = options.getLimits();
      const errors = [];
      let tooMany = false;
      let slots = used();

      for (const file of files) {
        const verdict = Quality.classifyFile(file, limits, options.acceptedTypes);
        if (verdict.rejected) { errors.push(verdict.message); continue; }
        if (slots >= limits.maxFilesPerRequest) { tooMany = true; continue; }
        if (verdict.kind === 'pdf') { slots++; options.addFile(file, null); continue; }

        const result = await prepareImage(file, limits, deps);
        if (!result.ok) {
          if (result.reason === 'resolution') errors.push(MESSAGES.resolutionTooLow(file.name));
          else if (result.reason === 'toolarge') errors.push(MESSAGES.imageTooHeavy(file.name, limits.maxFileSizeMb));
          else errors.push(MESSAGES.decode(file.name));
          continue;
        }
        slots++;
        if (source === 'camera' || source === 'gallery') {
          previews.push({ file: result.file, quality: result.quality, bitmap: result.bitmap, width: result.width, height: result.height, source });
          if (!current) showNext();
        } else {
          closeBitmap(result.bitmap);
          options.addFile(result.file, result.quality);
        }
      }
      if (tooMany) errors.push(MESSAGES.tooMany(limits.maxFilesPerRequest));
      if (errors.length) options.showErrors(errors);
    }

    return {
      handle(fileList, source = 'file') {
        const files = Array.from(fileList);
        chain = chain.then(() => process(files, source)).catch(() => options.showErrors([MESSAGES.decode('immagine')]));
        return chain;
      },
      // "Usa foto": solo ora il file elaborato entra in coda.
      use() {
        if (!current) return;
        const item = current;
        current = null;
        closeBitmap(item.bitmap);
        const limits = options.getLimits();
        if (options.getQueueSize() >= limits.maxFilesPerRequest) options.showErrors([MESSAGES.tooMany(limits.maxFilesPerRequest)]);
        else options.addFile(item.file, item.quality);
        showNext();
      },
      // "Rifai" / "Scegli un'altra": la foto viene scartata e non entra in coda.
      retake() {
        if (!current) return;
        const item = current;
        current = null;
        closeBitmap(item.bitmap);
        const hasMore = previews.length > 0;
        showNext();
        if (!hasMore) options.reopenPicker(item.source);
      },
    };
  }

  const api = { THRESHOLDS, prepareImage, createIntake, browserDeps };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageIntake = api;
})(typeof self !== 'undefined' ? self : globalThis);
