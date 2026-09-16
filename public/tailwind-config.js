// Estensione del tema Tailwind (Play CDN) per InvoiceExtract.
// Palette neutra (grigi caldi, tipo "stone") + un solo colore d'accento
// (indaco/blu), con supporto alla dark mode tramite classe "dark" su <html>.
// Caricato come file esterno same-origin per restare conforme alla
// Content-Security-Policy (niente script inline).
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['"Sora"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Base neutra: grigi caldi (non un grigio freddo/bluastro, e il
        // tono più scuro è un antracite, mai nero puro).
        ink: {
          50: '#FAFAF9',
          100: '#F5F5F4',
          200: '#E7E5E4',
          300: '#D6D3D1',
          400: '#A8A29E',
          500: '#78716C',
          600: '#57534E',
          700: '#44403C',
          800: '#292524',
          900: '#1C1917',
          950: '#0C0A09',
        },
        // Unico colore d'accento (indaco/blu saturo), usato esclusivamente
        // per CTA principali, badge/bordo della card Pro, check delle
        // feature list e link attivi/hover.
        brand: {
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#A5B4FC',
          400: '#818CF8',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#3730A3',
          900: '#312E81',
          950: '#1E1B4B',
        },
        // Stati semantici: invariati, non sono "accento" ma segnali
        // funzionali (OK / Da verificare / errore).
        success: { 50: '#ECFDF5', 100: '#D1FAE5', 300: '#6EE7B7', 400: '#34D399', 500: '#22C55E', 600: '#16A34A', 700: '#15803D', 900: '#064E3B' },
        warning: { 50: '#FFFBEB', 100: '#FEF3C7', 300: '#FCD34D', 400: '#FBBF24', 500: '#F59E0B', 600: '#D97706', 700: '#B45309', 900: '#78350F' },
        danger: { 50: '#FEF2F2', 100: '#FEE2E2', 300: '#FCA5A5', 500: '#EF4444', 600: '#DC2626', 700: '#B91C1C', 900: '#7F1D1D' },
      },
      boxShadow: {
        soft: '0 1px 2px rgba(28, 25, 23, 0.06)',
        card: '0 1px 2px rgba(28,25,23,0.04), 0 10px 30px -14px rgba(28, 25, 23, 0.22)',
        lifted: '0 2px 4px rgba(28,25,23,0.04), 0 28px 60px -20px rgba(28, 25, 23, 0.35)',
        brand: '0 18px 40px -14px rgba(79, 70, 229, 0.5)',
      },
    },
  },
};
