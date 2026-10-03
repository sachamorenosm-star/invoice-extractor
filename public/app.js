(() => {
  'use strict';

  // ---------------------------------------------------------------
  // Stato applicazione
  // ---------------------------------------------------------------
  const state = {
    files: [],       // File[] in coda per l'upload
    rows: [],        // Dati estratti (editabili) mostrati nella data grid
    testMode: false, // TEST_MODE=true se la versione è gratuita durante la beta
    testDailyLimit: null, // Limite pagine giornaliere TEST_MODE, null se non attivo
  };

  const els = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    fileQueue: document.getElementById('file-queue'),
    extractBtn: document.getElementById('extract-btn'),
    extractSpinner: document.getElementById('extract-spinner'),
    extractBtnLabel: document.getElementById('extract-btn-label'),
    errorBanner: document.getElementById('error-banner'),
    betaBanner: document.getElementById('beta-banner'),
    betaBannerText: document.getElementById('beta-banner-text'),
    resultsSection: document.getElementById('results-section'),
    resultsTbody: document.getElementById('results-tbody'),
    warningBanner: document.getElementById('warning-banner'),
    incompleteBanner: document.getElementById('incomplete-banner'),
    incompleteBannerText: document.getElementById('incomplete-banner-text'),
    downloadXlsx: document.getElementById('download-xlsx'),
    downloadCsv: document.getElementById('download-csv'),
    planBadge: document.getElementById('plan-badge'),
    scanLimitInfo: document.getElementById('scan-limit-info'),
    maxSizeLabel: document.getElementById('max-size-label'),
    toast: document.getElementById('toast'),
    themeToggle: document.getElementById('theme-toggle'),

    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    mobileMenu: document.getElementById('mobile-menu'),
    mobileMenuSettingsBtn: document.getElementById('mobile-menu-settings-btn'),
    mobileMenuLogoutBtn: document.getElementById('mobile-menu-logout-btn'),

    loginBtn: document.getElementById('login-btn'),
    accountArea: document.getElementById('account-area'),
    settingsBtn: document.getElementById('settings-btn'),
    accountBtn: document.getElementById('account-btn'),
    accountAvatarInitial: document.getElementById('account-avatar-initial'),
    accountDropdown: document.getElementById('account-dropdown'),
    accountDropdownEmail: document.getElementById('account-dropdown-email'),
    dropdownSettingsBtn: document.getElementById('dropdown-settings-btn'),
    dropdownLogoutBtn: document.getElementById('dropdown-logout-btn'),

    loginModal: document.getElementById('login-modal'),
    loginModalClose: document.getElementById('login-modal-close'),
    loginForm: document.getElementById('login-form'),
    loginEmailInput: document.getElementById('login-email-input'),
    loginSubmitBtn: document.getElementById('login-submit-btn'),
    loginModalMessage: document.getElementById('login-modal-message'),

    preCheckoutModal: document.getElementById('pre-checkout-modal'),
    preCheckoutModalClose: document.getElementById('pre-checkout-modal-close'),
    preCheckoutLoginBtn: document.getElementById('pre-checkout-login-btn'),
    preCheckoutContinueBtn: document.getElementById('pre-checkout-continue-btn'),

    pricingLaunchBadge: document.getElementById('pricing-launch-badge'),

    waitlistModal: document.getElementById('waitlist-modal'),
    waitlistModalClose: document.getElementById('waitlist-modal-close'),
    waitlistModalFormView: document.getElementById('waitlist-modal-form-view'),
    waitlistModalThankyouView: document.getElementById('waitlist-modal-thankyou-view'),
    waitlistModalPlanInfo: document.getElementById('waitlist-modal-plan-info'),
    waitlistForm: document.getElementById('waitlist-form'),
    waitlistEmailInput: document.getElementById('waitlist-email-input'),
    waitlistSubmitBtn: document.getElementById('waitlist-submit-btn'),
    waitlistModalError: document.getElementById('waitlist-modal-error'),

    accountModal: document.getElementById('account-modal'),
    accountModalClose: document.getElementById('account-modal-close'),
    accountEmailReadonly: document.getElementById('account-email-readonly'),
    recoveryEmailInput: document.getElementById('recovery-email-input'),
    recoveryEmailSaveBtn: document.getElementById('recovery-email-save-btn'),
    recoveryEmailMessage: document.getElementById('recovery-email-message'),
    accountPlanName: document.getElementById('account-plan-name'),
    accountPlanUsage: document.getElementById('account-plan-usage'),
    accountPlanProgressBar: document.getElementById('account-plan-progress-bar'),
    manageSubscriptionBtn: document.getElementById('manage-subscription-btn'),
    accountLogoutBtn: document.getElementById('account-logout-btn'),
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
  // Menu mobile (hamburger) — sotto la soglia md la <nav> desktop è
  // nascosta: questo pannello a comparsa la sostituisce, con gli stessi
  // link più, se loggato, le voci di profilo.
  // ---------------------------------------------------------------
  function isMobileMenuOpen() {
    return !els.mobileMenu.classList.contains('hidden');
  }
  function openMobileMenu() {
    els.mobileMenu.classList.remove('hidden');
    els.mobileMenuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMobileMenu() {
    els.mobileMenu.classList.add('hidden');
    els.mobileMenuBtn.setAttribute('aria-expanded', 'false');
  }

  els.mobileMenuBtn?.addEventListener('click', () => {
    if (isMobileMenuOpen()) closeMobileMenu();
    else openMobileMenu();
  });

  // Chiude il menu quando si clicca un link al suo interno (comodo su
  // mobile: altrimenti resterebbe aperto sopra la sezione a cui si è
  // appena navigato).
  els.mobileMenu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeMobileMenu);
  });

  // Chiusura da tastiera con Escape, riportando il focus sul pulsante
  // che l'ha aperto (comportamento atteso per un menu accessibile).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobileMenuOpen()) {
      closeMobileMenu();
      els.mobileMenuBtn.focus();
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
  // Accessibilità da tastiera: la drop-zone ha role="button" e tabindex="0"
  // (vedi index.html), quindi deve rispondere anche a Invio/Spazio come
  // farebbe un <button> nativo — altrimenti chi naviga da tastiera non ha
  // alcun modo di aprire il selettore file.
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => addFiles(els.fileInput.files));

  // ---------------------------------------------------------------
  // Incolla da appunti (Ctrl+V / Cmd+V)
  //
  // Ascolto globale sul documento: funziona con la pagina attiva senza
  // dover prima cliccare sulla drop-zone. Se gli appunti non contengono
  // un'immagine (es. l'utente ha incollato del testo altrove), non
  // facciamo nulla: nessun errore per un paste non destinato all'upload.
  // ---------------------------------------------------------------
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles = [];
    const timestamp = Date.now();
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const rawFile = item.getAsFile();
        if (!rawFile) continue;
        // Le immagini incollate di norma non hanno un nome reale: ne
        // assegniamo uno leggibile, con l'estensione dedotta dal MIME type.
        // L'indice evita nomi duplicati se vengono incollate più immagini
        // nello stesso evento (stesso timestamp in millisecondi).
        const ext = item.type.split('/')[1] || 'png';
        const suffix = pastedFiles.length > 0 ? `-${pastedFiles.length + 1}` : '';
        const namedFile = new File([rawFile], `immagine-incollata-${timestamp}${suffix}.${ext}`, { type: item.type });
        pastedFiles.push(namedFile);
      }
    }

    if (pastedFiles.length) {
      e.preventDefault();
      addFiles(pastedFiles);
    }
  });

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
          <span class="text-xs text-ink-500 dark:text-ink-400 shrink-0">${(f.size / 1024).toFixed(0)} KB</span>
        </div>
        <button data-idx="${i}" class="remove-file text-ink-500 dark:text-ink-400 hover:text-danger-500 dark:text-ink-500 dark:hover:text-danger-400 transition-colors duration-200 shrink-0 ml-2">
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
    hideIncompleteBanner();
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
        // Gestisci errori specifici di TEST_MODE prima del generico
        if (res.status === 401 && data.code === 'TEST_MODE_AUTH_REQUIRED') {
          showError('Accedi con il tuo link magico per utilizzare gratuitamente la versione di test.');
          return; // Non lanciare l'eccezione generica
        }
        if (res.status === 429 && data.code === 'TEST_DAILY_LIMIT_REACHED') {
          showError('Hai raggiunto il limite giornaliero della versione di test. Potrai riprovare domani.');
          return; // Non lanciare l'eccezione generica
        }
        throw new Error(data.error || 'Errore durante l\'estrazione dei dati.');
      }

      state.rows = data.results || [];
      state.files = [];
      renderFileQueue();
      renderResults();
      updatePlanUi(data.plan);

      // Banner PERSISTENTE (non un toast): l'IA potrebbe aver troncato
      // l'estrazione di un file con troppi documenti al suo interno.
      // Non va mai trattato come un successo silenzioso.
      if (data.incomplete) {
        showIncompleteBanner(data.incompleteMessage);
      } else {
        hideIncompleteBanner();
      }

      const pagesLabel = typeof data.pagesProcessed === 'number'
        ? `, ${data.pagesProcessed} pagina/e in totale`
        : '';
      showToast(`Estrazione completata: ${state.rows.length} documento/i elaborato/i${pagesLabel}.`);
      askPaywallSurvey();
    } catch (err) {
      showError(err.message);
    } finally {
      setExtracting(false);
    }
  });

  function showIncompleteBanner(message) {
    els.incompleteBannerText.innerHTML = `<strong>Estrazione incompleta.</strong> ${escapeHtml(message || "Alcuni documenti potrebbero non essere stati estratti.")}`;
    els.incompleteBanner.classList.remove('hidden');
  }
  function hideIncompleteBanner() {
    els.incompleteBanner.classList.add('hidden');
  }

  // ---------------------------------------------------------------
  // Micro-sondaggio dopo ogni estrazione riuscita: usa window.confirm()
  // nativo del browser invece di un banner custom nel DOM (più semplice
  // e affidabile, nessun elemento da inserire/nascondere). Nessun
  // collegamento ai dati delle fatture elaborate: solo risposta, timestamp
  // e numero di estrazioni fatte finora in questa sessione, salvati in
  // localStorage (nessuna chiamata al backend per ora).
  // ---------------------------------------------------------------
  const SURVEY_RESPONSES_KEY = 'ie_survey_responses';
  let extractionCount = 0;

  function askPaywallSurvey() {
    extractionCount += 1;
    const wouldPay = window.confirm(
      'Ti è stato utile questo strumento? Clicca OK se pagheresti per usarlo, Annulla se no.',
    );
    const record = {
      would_pay: wouldPay ? 'si' : 'no',
      timestamp: Date.now(),
      extraction_count: extractionCount,
    };
    try {
      const existing = JSON.parse(localStorage.getItem(SURVEY_RESPONSES_KEY) || '[]');
      existing.push(record);
      localStorage.setItem(SURVEY_RESPONSES_KEY, JSON.stringify(existing));
    } catch (_) {
      // Non bloccante: il segnale è opzionale, non deve interrompere l'uso dell'app.
    }
  }

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
            <button class="remove-row text-ink-500 dark:text-ink-400 hover:text-danger-500 dark:text-ink-500 dark:hover:text-danger-400 transition-colors duration-200" data-idx="${i}" title="Rimuovi riga">
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
  // Autenticazione (Magic Link) e sezione "Il mio profilo"
  //
  // Nessuna password: l'utente riceve via email un link temporaneo che,
  // una volta cliccato, imposta un cookie di sessione httpOnly lato
  // server. Qui gestiamo solo l'interfaccia: apertura modali, invio
  // della richiesta di link, lettura dello stato utente autenticato.
  // ---------------------------------------------------------------
  let currentAuthUser = null; // { email, recovery_email, plan } oppure null se non loggato

  function openModal(modalEl) {
    modalEl.classList.remove('hidden');
  }
  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
  }

  els.loginBtn?.addEventListener('click', () => {
    els.loginModalMessage.classList.add('hidden');
    els.loginForm.classList.remove('hidden');
    els.loginEmailInput.value = '';
    openModal(els.loginModal);
    els.loginEmailInput.focus();
  });
  els.loginModalClose?.addEventListener('click', () => closeModal(els.loginModal));
  els.loginModal?.addEventListener('click', (e) => {
    if (e.target === els.loginModal) closeModal(els.loginModal);
  });

  els.loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = els.loginEmailInput.value.trim();
    if (!email) return;

    els.loginSubmitBtn.disabled = true;
    els.loginSubmitBtn.textContent = 'Invio in corso…';
    try {
      const res = await fetch('/api/auth/request-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      els.loginForm.classList.add('hidden');
      els.loginModalMessage.textContent = data.message || 'Controlla la tua email: ti abbiamo inviato un link di accesso.';
      els.loginModalMessage.classList.remove('hidden');
    } catch (err) {
      showToast('Errore di rete: riprova tra poco.', true);
    } finally {
      els.loginSubmitBtn.disabled = false;
      els.loginSubmitBtn.textContent = 'Invia link di accesso';
    }
  });

  // Menu a tendina dell'avatar: si apre/chiude al click, si chiude
  // cliccando fuori.
  els.accountBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    els.accountDropdown.classList.toggle('hidden');
  });
  els.accountDropdown?.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    els.accountDropdown?.classList.add('hidden');
  });

  function updateAccountModalUi(user) {
    if (!user) return;
    els.accountEmailReadonly.textContent = user.email || '—';
    els.recoveryEmailInput.value = user.recovery_email || '';
    updateAccountPlanUi(user.plan);
  }

  function updateAccountPlanUi(plan) {
    if (!plan) return;
    els.accountPlanName.textContent = PLAN_LABELS[plan.tier] || 'Piano Free';
    const limitLabel = plan.limitLabel || plan.limit;
    els.accountPlanUsage.textContent = `${plan.used}/${limitLabel} pagine`;
    const isUnlimited = plan.tier === 'studio';
    const pct = isUnlimited ? 100 : Math.min(100, plan.limit > 0 ? (plan.used / plan.limit) * 100 : 0);
    els.accountPlanProgressBar.style.width = `${pct}%`;
  }

  function openAccountModal() {
    els.accountDropdown?.classList.add('hidden');
    updateAccountModalUi(currentAuthUser);
    openModal(els.accountModal);
  }
  els.settingsBtn?.addEventListener('click', openAccountModal);
  els.dropdownSettingsBtn?.addEventListener('click', openAccountModal);
  els.mobileMenuSettingsBtn?.addEventListener('click', () => {
    closeMobileMenu();
    openAccountModal();
  });
  els.accountModalClose?.addEventListener('click', () => closeModal(els.accountModal));
  els.accountModal?.addEventListener('click', (e) => {
    if (e.target === els.accountModal) closeModal(els.accountModal);
  });

  els.recoveryEmailSaveBtn?.addEventListener('click', async () => {
    const recoveryEmail = els.recoveryEmailInput.value.trim();
    els.recoveryEmailSaveBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/recovery-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recovery_email: recoveryEmail || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Impossibile salvare.');
      if (currentAuthUser) currentAuthUser.recovery_email = recoveryEmail || null;
      els.recoveryEmailMessage.textContent = 'Email di recupero salvata.';
      els.recoveryEmailMessage.classList.remove('hidden');
      clearTimeout(els.recoveryEmailSaveBtn._t);
      els.recoveryEmailSaveBtn._t = setTimeout(() => els.recoveryEmailMessage.classList.add('hidden'), 3000);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.recoveryEmailSaveBtn.disabled = false;
    }
  });

  els.manageSubscriptionBtn?.addEventListener('click', async () => {
    // Piano Free: nessun abbonamento da gestire, portiamo l'utente alla
    // sezione prezzi invece di chiamare un endpoint che fallirebbe.
    if (!currentAuthUser?.plan || currentAuthUser.plan.tier === 'free') {
      closeModal(els.accountModal);
      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const originalLabel = els.manageSubscriptionBtn.textContent;
    els.manageSubscriptionBtn.disabled = true;
    els.manageSubscriptionBtn.textContent = 'Attendere…';
    try {
      const res = await fetch('/api/stripe/create-portal-session', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Impossibile aprire la gestione abbonamento.');
      window.location.href = data.url;
    } catch (err) {
      showToast(err.message, true);
      els.manageSubscriptionBtn.disabled = false;
      els.manageSubscriptionBtn.textContent = originalLabel;
    }
  });

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {
      // Anche se la richiesta fallisce, ripuliamo comunque lo stato lato client.
    }
    closeModal(els.accountModal);
    els.accountDropdown?.classList.add('hidden');
    updateAuthUi(null);
    showToast('Sei uscito dal tuo account.');
    fetchInitialStatus();
  }
  els.dropdownLogoutBtn?.addEventListener('click', logout);
  els.accountLogoutBtn?.addEventListener('click', logout);
  els.mobileMenuLogoutBtn?.addEventListener('click', () => {
    closeMobileMenu();
    logout();
  });

  function updateAuthUi(user) {
    currentAuthUser = user;
    if (user) {
      els.loginBtn.classList.add('hidden');
      els.accountArea.classList.remove('hidden');
      els.accountArea.classList.add('flex');
      els.accountAvatarInitial.textContent = (user.email || '?').charAt(0).toUpperCase();
      els.accountDropdownEmail.textContent = user.email || '';
      els.mobileMenuSettingsBtn?.classList.remove('hidden');
      els.mobileMenuLogoutBtn?.classList.remove('hidden');
      updatePlanUi(user.plan);
    } else {
      els.loginBtn.classList.remove('hidden');
      els.accountArea.classList.add('hidden');
      els.accountArea.classList.remove('flex');
      els.mobileMenuSettingsBtn?.classList.add('hidden');
      els.mobileMenuLogoutBtn?.classList.add('hidden');
    }
  }

  // Interroga /api/auth/me (basato sul cookie di sessione, inviato
  // automaticamente dal browser essendo same-origin). Restituisce i dati
  // utente se loggato, altrimenti null senza generare errori visibili.
  async function fetchAuthStatus() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        updateAuthUi(data);
        return data;
      }
    } catch (_) {
      // Non bloccante.
    }
    updateAuthUi(null);
    return null;
  }

  // ---------------------------------------------------------------
  // Stripe Checkout
  //
  // Ogni card prezzi (tranne Free) ha un proprio pulsante con
  // data-plan="starter|business|growth|studio": il piano scelto viene
  // passato al backend per creare la Checkout Session corretta.
  //
  // Se l'utente NON è loggato, prima di procedere mostriamo un invito
  // (non un blocco) ad accedere: un account collegato è ciò che gli
  // permette di ritrovare/gestire l'abbonamento in futuro (Customer
  // Portal). Può comunque scegliere di continuare senza accedere.
  // ---------------------------------------------------------------
  let pendingCheckoutPlan = null;

  async function startCheckout(plan, btn) {
    const originalLabel = btn.textContent;
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
  }

  document.querySelectorAll('.subscribe-plan-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const plan = btn.dataset.plan;
      if (!plan) return;

      // Modalità "waitlist" (pre-lancio, senza Partita IVA attiva): nessun
      // checkout reale, raccogliamo solo l'interesse via /api/waitlist/join.
      if (launchMode === 'waitlist') {
        openWaitlistModal(btn);
        return;
      }

      if (!currentAuthUser) {
        pendingCheckoutPlan = plan;
        openModal(els.preCheckoutModal);
        return;
      }
      startCheckout(plan, btn);
    });
  });

  // ---------------------------------------------------------------
  // Lista d'attesa (LAUNCH_MODE=waitlist)
  // ---------------------------------------------------------------
  let waitlistPlan = null;

  function openWaitlistModal(btn) {
    waitlistPlan = btn.dataset.plan;
    const planName = btn.dataset.planName || waitlistPlan;
    const price = btn.dataset.price || '';
    els.waitlistModalPlanInfo.textContent = price
      ? `Ti interessa il piano ${planName} a ${price}/mese?`
      : `Ti interessa il piano ${planName}?`;
    els.waitlistModalError.classList.add('hidden');
    els.waitlistEmailInput.value = '';
    els.waitlistForm.classList.remove('hidden');
    els.waitlistModalFormView.classList.remove('hidden');
    els.waitlistModalThankyouView.classList.add('hidden');
    openModal(els.waitlistModal);
    els.waitlistEmailInput.focus();
  }

  els.waitlistForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = els.waitlistEmailInput.value.trim();
    if (!email || !waitlistPlan) return;

    els.waitlistModalError.classList.add('hidden');
    els.waitlistSubmitBtn.disabled = true;
    const originalLabel = els.waitlistSubmitBtn.textContent;
    els.waitlistSubmitBtn.textContent = 'Invio in corso…';
    try {
      const res = await fetch('/api/waitlist/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, plan: waitlistPlan }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Impossibile registrare la richiesta.');

      els.waitlistModalFormView.classList.add('hidden');
      els.waitlistModalThankyouView.classList.remove('hidden');
    } catch (err) {
      els.waitlistModalError.textContent = err.message;
      els.waitlistModalError.classList.remove('hidden');
    } finally {
      els.waitlistSubmitBtn.disabled = false;
      els.waitlistSubmitBtn.textContent = originalLabel;
    }
  });

  els.waitlistModalClose?.addEventListener('click', () => closeModal(els.waitlistModal));
  els.waitlistModal?.addEventListener('click', (e) => {
    if (e.target === els.waitlistModal) closeModal(els.waitlistModal);
  });

  els.preCheckoutLoginBtn?.addEventListener('click', () => {
    closeModal(els.preCheckoutModal);
    els.loginBtn.click();
  });
  els.preCheckoutContinueBtn?.addEventListener('click', () => {
    closeModal(els.preCheckoutModal);
    if (!pendingCheckoutPlan) return;
    const btn = document.querySelector(`.subscribe-plan-btn[data-plan="${pendingCheckoutPlan}"]`);
    if (btn) startCheckout(pendingCheckoutPlan, btn);
  });
  els.preCheckoutModalClose?.addEventListener('click', () => closeModal(els.preCheckoutModal));
  els.preCheckoutModal?.addEventListener('click', (e) => {
    if (e.target === els.preCheckoutModal) closeModal(els.preCheckoutModal);
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

  // Un piano a pagamento deve sempre risultare legato a un'identità
  // verificabile (l'email dell'account), non al solo ID anonimo salvato in
  // localStorage: chiunque usi lo stesso browser/dispositivo (o l'utente
  // stesso dopo un logout) vedrebbe altrimenti un piano a pagamento che
  // non è "suo" in alcun senso verificabile. Perciò, se non c'è una sessione
  // autenticata attiva, mostriamo sempre "Piano Free" anche se l'ID anonimo
  // sottostante risulta collegato a un piano a pagamento.
  //
  // Eccezione voluta: subito dopo un checkout completato in questa stessa
  // scheda (vedi pollForPlanActivation), mostriamo la conferma immediata del
  // piano appena attivato anche da anonimi — è un riscontro dell'azione
  // appena compiuta dall'utente, non uno stato "ritrovato" da una sessione
  // precedente, e coincide con il messaggio di conferma mostrato in toast.
  function updatePlanUi(plan, { allowAnonymousPaid = false } = {}) {
    if (!plan) return;
    const showAsFree = !currentAuthUser && plan.tier !== 'free' && !allowAnonymousPaid;
    const displayTier = showAsFree ? 'free' : plan.tier;
    const isPaid = displayTier !== 'free';

    els.planBadge.textContent = PLAN_LABELS[displayTier] || 'Piano Free';
    els.planBadge.classList.remove(...PLAN_BADGE_FREE_CLASSES, ...PLAN_BADGE_PAID_CLASSES);
    els.planBadge.classList.add(...(isPaid ? PLAN_BADGE_PAID_CLASSES : PLAN_BADGE_FREE_CLASSES));
    els.planBadge.classList.remove('hidden');

    if (showAsFree) {
      els.scanLimitInfo.textContent = 'Accedi per vedere l\'utilizzo del tuo abbonamento.';
    } else {
      const limitLabel = plan.limitLabel || plan.limit;
      els.scanLimitInfo.textContent = `Pagine elaborate questo mese: ${plan.used}/${limitLabel}`;
    }
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
        launchMode = data.launchMode === 'live' ? 'live' : 'waitlist';
        applyLaunchModeUi();

        // TEST_MODE beta UX: carica la configurazione della versione di test
        if (data.testMode === true) {
          state.testMode = true;
          state.testDailyLimit = data.testDailyLimit || 50;
          updateBetaBannerUi();
        } else {
          state.testMode = false;
          state.testDailyLimit = null;
          hideBetaBanner();
        }
      }
    } catch (_) { /* usa i default */ }
  }

  function updateBetaBannerUi() {
    if (state.testMode && state.testDailyLimit > 0) {
      // Mostra il banner beta con il limite giornaliero
      const limitText = state.testDailyLimit === 50
        ? 'fino a 50 pagine al giorno'
        : `fino a ${state.testDailyLimit} pagine al giorno`;
      els.betaBannerText.textContent = `Versione di test — gratuita durante la fase di validazione · ${limitText}`;
      els.betaBanner.classList.remove('hidden');
    } else if (state.testMode && state.testDailyLimit <= 0) {
      // Estrazione temporaneamente non disponibile
      els.betaBannerText.textContent = 'Versione di test — estrazione temporaneamente non disponibile';
      els.betaBanner.classList.remove('hidden');
    } else {
      hideBetaBanner();
    }
  }

  function hideBetaBanner() {
    els.betaBanner.classList.add('hidden');
  }

  // ---------------------------------------------------------------
  // Modalità di lancio (waitlist vs live) — vedi src/server.js /api/config.
  // Il piano Free non è mai interessato: resta sempre un link diretto
  // all'uso del prodotto, indipendentemente da questo interruttore.
  // ---------------------------------------------------------------
  let launchMode = 'waitlist';

  function applyLaunchModeUi() {
    if (launchMode === 'waitlist') {
      els.pricingLaunchBadge?.classList.remove('hidden');
      document.querySelectorAll('.subscribe-plan-btn').forEach((btn) => {
        const planName = btn.dataset.planName || '';
        btn.textContent = 'Richiedi accesso anticipato';
        if (planName) btn.setAttribute('aria-label', `Richiedi accesso anticipato al piano ${planName}`);
      });
    } else {
      els.pricingLaunchBadge?.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  document.getElementById('year').textContent = new Date().getFullYear();

  // Se l'utente è già loggato (cookie di sessione valido), fetchAuthStatus
  // popola subito navbar e piano reale; altrimenti ricadiamo sullo stato
  // anonimo basato su X-User-Id, invariato rispetto a prima.
  fetchAuthStatus().then((user) => {
    if (!user) fetchInitialStatus();
  });
  fetchConfig();

  // Se l'utente torna da Stripe Checkout, NON ci fidiamo mai del solo
  // parametro URL "?checkout=success": indica solo che Stripe ha completato
  // il pagamento e reindirizzato il browser, non che il nostro webhook abbia
  // già attivato l'abbonamento nel database (la scrittura avviene in modo
  // asincrono, con una latenza variabile). Interroghiamo quindi lo stato
  // reale con qualche tentativo ravvicinato prima di dichiarare successo.
  async function pollForPlanActivation(maxAttempts = 8, intervalMs = 1500) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetch('/api/stripe/status', { headers: { 'X-User-Id': getUserId() } });
        if (res.ok) {
          const data = await res.json();
          if (data.plan) {
            // Conferma immediata dell'azione appena compiuta (checkout in
            // questa stessa scheda): va mostrata anche da anonimi, vedi
            // il commento su updatePlanUi.
            updatePlanUi(data.plan, { allowAnonymousPaid: true });
            if (data.plan.tier !== 'free') {
              return data.plan;
            }
          }
        }
      } catch (_) {
        // Riprova al tentativo successivo.
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    // Rimuove il parametro dall'URL subito, così un refresh manuale non
    // ripete il polling né mostra di nuovo il messaggio.
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Pagamento ricevuto: stiamo attivando il tuo abbonamento…');
    pollForPlanActivation().then((plan) => {
      if (plan) {
        showToast(`${PLAN_LABELS[plan.tier] || 'Abbonamento'} attivato con successo! Grazie.`);
      } else {
        showToast(
          "Pagamento ricevuto, ma l'attivazione sta richiedendo più tempo del previsto. Ricarica la pagina tra qualche istante; se il piano non risulta aggiornato, contatta il supporto.",
          true,
        );
      }
    });
  } else if (params.get('checkout') === 'cancel') {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Pagamento annullato.', true);
  }

  // Redirect dal login via Magic Link (vedi src/routes/auth.js -> /verify).
  if (params.get('login') === 'success') {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Accesso effettuato con successo!');
    fetchAuthStatus();
  } else if (params.get('login') === 'expired') {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Il link di accesso non è valido o è scaduto. Richiedine uno nuovo.', true);
  }

  // Ritorno dal Customer Portal Stripe (return_url): riapre la sezione
  // profilo con lo stato aggiornato.
  if (params.get('section') === 'account') {
    window.history.replaceState({}, document.title, window.location.pathname);
    fetchAuthStatus().then((user) => {
      if (user) openAccountModal();
    });
  }
})();
