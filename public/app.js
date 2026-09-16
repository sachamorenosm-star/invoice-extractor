(() => {
  'use strict';

  // ---------------------------------------------------------------
  // Stato applicazione
  // ---------------------------------------------------------------
  const state = {
    files: [],       // File[] in coda per l'upload
    rows: [],        // Dati estratti (editabili) mostrati nella data grid
  };

  const els = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    fileQueue: document.getElementById('file-queue'),
    extractBtn: document.getElementById('extract-btn'),
    extractSpinner: document.getElementById('extract-spinner'),
    extractBtnLabel: document.getElementById('extract-btn-label'),
    errorBanner: document.getElementById('error-banner'),
    resultsSection: document.getElementById('results-section'),
    resultsTbody: document.getElementById('results-tbody'),
    warningBanner: document.getElementById('warning-banner'),
    downloadXlsx: document.getElementById('download-xlsx'),
    downloadCsv: document.getElementById('download-csv'),
    planBadge: document.getElementById('plan-badge'),
    scanLimitInfo: document.getElementById('scan-limit-info'),
    maxSizeLabel: document.getElementById('max-size-label'),
    toast: document.getElementById('toast'),
    themeToggle: document.getElementById('theme-toggle'),
  };

  // ---------------------------------------------------------------
  // Tema chiaro/scuro
  //
  // Priorità: scelta manuale salvata in localStorage > preferenza di
  // sistema (prefers-color-scheme). Se l'utente non ha mai scelto
  // manualmente, la pagina segue la preferenza di sistema anche se
  // cambia mentre la pagina è aperta (theme-init.js applica già lo
  // stato corretto al primo caricamento per evitare il flash).
  // ---------------------------------------------------------------
  const THEME_STORAGE_KEY = 'ie_theme';
  const prefersDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setStoredTheme(value) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (e) {
      // Ambiente senza localStorage: la scelta non persiste, non blocchiamo l'uso.
    }
  }

  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
  }

  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', () => {
      const isDark = !document.documentElement.classList.contains('dark');
      applyTheme(isDark);
      setStoredTheme(isDark ? 'dark' : 'light');
    });
  }

  // Se il sistema cambia tema mentre la pagina è aperta e l'utente non ha
  // mai scelto manualmente, seguiamo il nuovo valore in tempo reale.
  prefersDarkQuery.addEventListener('change', (e) => {
    if (!getStoredTheme()) {
      applyTheme(e.matches);
    }
  });

  // ---------------------------------------------------------------
  // Identificazione utente anonima (per limiti di piano/scansioni)
  // Nessun dato personale: solo un ID casuale salvato in localStorage.
  // ---------------------------------------------------------------
  function getUserId() {
    let id = localStorage.getItem('ext_user_id');
    if (!id) {
      id = 'usr_' + crypto.randomUUID();
      localStorage.setItem('ext_user_id', id);
    }
    return id;
  }

  function showToast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    els.toast.classList.toggle('bg-danger-600', isError);
    els.toast.classList.toggle('bg-ink-900', !isError);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.add('hidden'), 4000);
  }

  function showError(message) {
    els.errorBanner.textContent = message;
    els.errorBanner.classList.remove('hidden');
  }
  function clearError() {
    els.errorBanner.classList.add('hidden');
    els.errorBanner.textContent = '';
  }

  // ---------------------------------------------------------------
  // Drag & Drop
  // ---------------------------------------------------------------
  ['dragenter', 'dragover'].forEach((evt) => {
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('dragover');
    });
  });
  els.dropZone.addEventListener('drop', (e) => {
    addFiles(e.dataTransfer.files);
  });
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => addFiles(els.fileInput.files));

  const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const MAX_FILE_SIZE_MB = 10; // aggiornato da /api/config se disponibile

  function addFiles(fileList) {
    clearError();
    const incoming = Array.from(fileList);
    const rejected = [];

    for (const file of incoming) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        rejected.push(`${file.name} (tipo non supportato)`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        rejected.push(`${file.name} (supera ${MAX_FILE_SIZE_MB}MB)`);
        continue;
      }
      state.files.push(file);
    }

    if (rejected.length) {
      showError('File scartati: ' + rejected.join(', '));
    }

    renderFileQueue();
  }

  function renderFileQueue() {
    if (!state.files.length) {
      els.fileQueue.classList.add('hidden');
      els.fileQueue.innerHTML = '';
      els.extractBtn.disabled = true;
      return;
    }
    els.fileQueue.classList.remove('hidden');
    els.extractBtn.disabled = false;
    els.fileQueue.innerHTML = state.files.map((f, i) => `
      <div class="flex items-center justify-between bg-white border border-ink-100 rounded-2xl px-4 py-2.5 shadow-soft transition-all duration-200 hover:shadow-card dark:bg-ink-900 dark:border-ink-800">
        <div class="flex items-center gap-2 min-w-0">
          <span class="flex items-center justify-center w-8 h-8 rounded-xl bg-brand-50 dark:bg-brand-900/30 shrink-0">
            <svg class="w-4 h-4 text-brand-600 dark:text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
          </span>
          <span class="truncate text-sm font-medium text-ink-700 dark:text-ink-200">${escapeHtml(f.name)}</span>
          <span class="text-xs text-ink-400 dark:text-ink-500 shrink-0">${(f.size / 1024).toFixed(0)} KB</span>
        </div>
        <button data-idx="${i}" class="remove-file text-ink-400 hover:text-danger-500 dark:text-ink-500 dark:hover:text-danger-400 transition-colors duration-200 shrink-0 ml-2">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
    `).join('');

    els.fileQueue.querySelectorAll('.remove-file').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        state.files.splice(idx, 1);
        renderFileQueue();
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------
  // Estrazione dati (chiamata backend -> Claude)
  // ---------------------------------------------------------------
  els.extractBtn.addEventListener('click', async () => {
    if (!state.files.length) return;
    clearError();
    setExtracting(true);

    const formData = new FormData();
    state.files.forEach((f) => formData.append('invoices', f));

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'X-User-Id': getUserId() },
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Errore durante l\'estrazione dei dati.');
      }

      state.rows = data.results || [];
      state.files = [];
      renderFileQueue();
      renderResults();
      updatePlanUi(data.plan);
      const pagesLabel = typeof data.pagesProcessed === 'number'
        ? `, ${data.pagesProcessed} pagina/e in totale`
        : '';
      showToast(`Estrazione completata: ${state.rows.length} documento/i elaborato/i${pagesLabel}.`);
    } catch (err) {
      showError(err.message);
    } finally {
      setExtracting(false);
    }
  });

  function setExtracting(isLoading) {
    els.extractBtn.disabled = isLoading || !state.files.length;
    els.extractSpinner.classList.toggle('hidden', !isLoading);
    els.extractBtnLabel.textContent = isLoading ? 'Estrazione in corso…' : "Estrai dati con l'IA";
  }

  // ---------------------------------------------------------------
  // Data grid di anteprima (editabile)
  // ---------------------------------------------------------------
  function renderResults() {
    if (!state.rows.length) {
      els.resultsSection.classList.add('hidden');
      return;
    }
    els.resultsSection.classList.remove('hidden');

    const hasWarning = state.rows.some((r) => r.math_verified === false);
    els.warningBanner.classList.toggle('hidden', !hasWarning);

    els.resultsTbody.innerHTML = state.rows.map((row, i) => {
      const warn = row.math_verified === false;
      const editHint = 'Clicca per modificare';
      const suggestion = warn ? computeMathSuggestion(row) : null;
      return `
        <tr data-idx="${i}" class="${warn ? 'row-warning' : 'row-ok'} transition-colors duration-200">
          <td class="px-3 py-2.5 text-ink-500 dark:text-ink-400 max-w-[140px] truncate align-top" title="${escapeHtml(row.source_file || '')}">${escapeHtml(row.source_file || '-')}</td>
          <td class="px-3 py-2.5 field align-top" data-field="supplier" contenteditable="true" title="${editHint}">${escapeHtml(row.supplier || '')}</td>
          <td class="px-3 py-2.5 field align-top" data-field="invoice_number" contenteditable="true" title="${editHint}">${escapeHtml(row.invoice_number || '')}</td>
          <td class="px-3 py-2.5 field align-top" data-field="date" contenteditable="true" title="${editHint}">${escapeHtml(row.date || '')}</td>
          <td class="px-3 py-2.5 text-right field align-top" data-field="subtotal" contenteditable="true" title="${editHint}">${formatNum(row.subtotal)}</td>
          <td class="px-3 py-2.5 text-right field align-top" data-field="vat_amount" contenteditable="true" title="${editHint}">${formatNum(row.vat_amount)}</td>
          <td class="px-3 py-2.5 text-right field align-top" data-field="total" contenteditable="true" title="${editHint}">${formatNum(row.total)}</td>
          <td class="px-3 py-2.5 field align-top" data-field="currency" contenteditable="true" title="${editHint}">${escapeHtml(row.currency || '')}</td>
          <td class="px-3 py-2.5 text-center align-top">
            ${warn
              ? '<span class="inline-flex items-center gap-1 rounded-full bg-warning-100 text-warning-700 dark:bg-warning-900/40 dark:text-warning-300 text-xs font-semibold px-2 py-0.5">⚠️ Da verificare</span>'
              : '<span class="inline-flex items-center gap-1 rounded-full bg-success-100 text-success-700 dark:bg-success-900/40 dark:text-success-300 text-xs font-semibold px-2 py-0.5">✓ OK</span>'}
            ${suggestion ? `
              <div class="mt-1.5 text-[11px] leading-snug text-ink-500 dark:text-ink-400 italic max-w-[230px] mx-auto text-left">
                💡 Suggerimento: se <strong class="not-italic text-ink-700 dark:text-ink-200">${suggestion.fieldLabel}</strong> fosse
                <strong class="not-italic text-ink-700 dark:text-ink-200">${suggestion.suggestedText}</strong>
                invece di <strong class="not-italic text-ink-700 dark:text-ink-200">${suggestion.currentText}</strong>,
                i calcoli tornerebbero. Verifica sul documento originale prima di modificare.
              </div>
            ` : ''}
          </td>
          <td class="px-3 py-2.5 text-center align-top">
            <button class="remove-row text-ink-400 hover:text-danger-500 dark:text-ink-500 dark:hover:text-danger-400 transition-colors duration-200" data-idx="${i}" title="Rimuovi riga">
              <svg class="w-4 h-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Sincronizza le modifiche manuali con lo stato + ricalcola il flag di verifica
    els.resultsTbody.querySelectorAll('.field').forEach((cell) => {
      cell.addEventListener('blur', (e) => {
        const tr = e.target.closest('tr');
        const idx = parseInt(tr.dataset.idx, 10);
        const field = e.target.dataset.field;
        let value = e.target.textContent.trim();
        if (['subtotal', 'vat_amount', 'total'].includes(field)) {
          value = parseFloat(value.replace(',', '.')) || 0;
        }
        state.rows[idx][field] = value;
        recomputeVerification(idx);
        renderResults();
      });
    });

    els.resultsTbody.querySelectorAll('.remove-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        state.rows.splice(idx, 1);
        renderResults();
      });
    });
  }

  function formatNum(n) {
    if (n === undefined || n === null || n === '') return '';
    const num = Number(n);
    return Number.isFinite(num) ? num.toFixed(2) : String(n);
  }

  function recomputeVerification(idx) {
    const row = state.rows[idx];
    const sub = Number(row.subtotal) || 0;
    const vat = Number(row.vat_amount) || 0;
    const total = Number(row.total) || 0;
    const diff = Math.abs(sub + vat - total);
    row.math_verified = diff <= 0.01;
  }

  // Calcola un'IPOTESI (non una correzione) di quale sarebbe il Totale
  // "atteso" se Imponibile e IVA fossero corretti così come inseriti.
  // Non modifica mai i dati: serve solo a suggerire all'utente cosa
  // controllare sul documento originale.
  function computeMathSuggestion(row) {
    const sub = Number(row.subtotal);
    const vat = Number(row.vat_amount);
    const total = Number(row.total);

    if (![sub, vat, total].every(Number.isFinite)) return null;

    const expectedTotal = Math.round((sub + vat) * 100) / 100;
    if (Math.abs(expectedTotal - total) <= 0.01) return null;

    const currency = row.currency || 'EUR';
    return {
      fieldLabel: 'il Totale',
      suggestedText: `${expectedTotal.toFixed(2)} ${currency}`,
      currentText: `${total.toFixed(2)} ${currency}`,
    };
  }

  // ---------------------------------------------------------------
  // Download Excel / CSV
  // ---------------------------------------------------------------
  els.downloadXlsx.addEventListener('click', () => downloadExport('xlsx'));
  els.downloadCsv.addEventListener('click', () => downloadExport('csv'));

  async function downloadExport(format) {
    if (!state.rows.length) return;
    try {
      const res = await fetch(`/api/export/${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: state.rows }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Errore durante la generazione del file.');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'xlsx' ? 'fatture-estratte.xlsx' : 'fatture-estratte.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      showError(err.message);
    }
  }

  // ---------------------------------------------------------------
  // Stripe Checkout
  //
  // Ogni card prezzi (tranne Free) ha un proprio pulsante con
  // data-plan="starter|business|growth|studio": il piano scelto viene
  // passato al backend per creare la Checkout Session corretta.
  // ---------------------------------------------------------------
  document.querySelectorAll('.subscribe-plan-btn').forEach((btn) => {
    const originalLabel = btn.textContent;
    btn.addEventListener('click', async () => {
      const plan = btn.dataset.plan;
      if (!plan) return;

      btn.disabled = true;
      btn.textContent = 'Attendere…';
      try {
        const res = await fetch('/api/stripe/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': getUserId() },
          body: JSON.stringify({ plan }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) {
          throw new Error(data.error || 'Impossibile avviare il pagamento.');
        }
        window.location.href = data.url;
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  // ---------------------------------------------------------------
  // Stato piano / limiti di pagine (5 tier: free, starter, business,
  // growth, studio — "studio" viene mostrato come "Illimitato" tramite
  // plan.limitLabel, calcolato lato server).
  // ---------------------------------------------------------------
  const PLAN_LABELS = {
    free: 'Piano Free',
    starter: 'Piano Starter',
    business: 'Piano Business',
    growth: 'Piano Growth',
    studio: 'Piano Studio',
  };
  const PLAN_BADGE_FREE_CLASSES = ['bg-ink-100', 'text-ink-600', 'dark:bg-ink-800', 'dark:text-ink-300'];
  const PLAN_BADGE_PAID_CLASSES = ['bg-brand-100', 'text-brand-700', 'dark:bg-brand-900/40', 'dark:text-brand-300'];

  function updatePlanUi(plan) {
    if (!plan) return;
    const isPaid = plan.tier !== 'free';
    els.planBadge.textContent = PLAN_LABELS[plan.tier] || 'Piano Free';
    els.planBadge.classList.remove(...PLAN_BADGE_FREE_CLASSES, ...PLAN_BADGE_PAID_CLASSES);
    els.planBadge.classList.add(...(isPaid ? PLAN_BADGE_PAID_CLASSES : PLAN_BADGE_FREE_CLASSES));
    els.planBadge.classList.remove('hidden');

    const limitLabel = plan.limitLabel || plan.limit;
    els.scanLimitInfo.textContent = `Pagine elaborate questo mese: ${plan.used}/${limitLabel}`;
  }

  async function fetchInitialStatus() {
    try {
      const res = await fetch('/api/stripe/status', {
        headers: { 'X-User-Id': getUserId() },
      });
      if (res.ok) {
        const data = await res.json();
        updatePlanUi(data.plan);
      }
    } catch (_) {
      // Non bloccante: se il backend non risponde mostriamo solo lo stato di default
    }
  }

  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data.maxFileSizeMb) {
          els.maxSizeLabel.textContent = data.maxFileSizeMb;
        }
      }
    } catch (_) { /* usa i default */ }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  document.getElementById('year').textContent = new Date().getFullYear();
  fetchInitialStatus();
  fetchConfig();

  // Se l'utente torna da Stripe Checkout con esito positivo, aggiorna lo stato
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    showToast('Abbonamento attivato con successo! Grazie.');
    setTimeout(fetchInitialStatus, 1500);
  } else if (params.get('checkout') === 'cancel') {
    showToast('Pagamento annullato.', true);
  }
})();
