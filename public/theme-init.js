// Applica il tema (chiaro/scuro) PRIMA che il resto della pagina venga
// disegnato, per evitare un flash del tema sbagliato. Deve restare il primo
// <script> caricato in <head>. File esterno (non inline) per rispettare la
// Content-Security-Policy del server, che non consente script inline.
(function () {
  try {
    var stored = localStorage.getItem('ie_theme'); // 'dark' | 'light' | null
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = stored ? stored === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', isDark);
  } catch (e) {
    // Ambiente senza localStorage/matchMedia (raro): resta in modalità chiara.
  }
})();
