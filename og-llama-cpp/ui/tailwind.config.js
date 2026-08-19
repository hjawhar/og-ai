/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        // One dark ramp, named by role so components never hard-code a zinc shade.
        surface: {
          base: '#0a0a0c',
          panel: '#121216',
          raised: '#1a1a20',
          hover: '#212129',
          line: '#2a2a33',
        },
        ink: {
          bright: '#f4f4f6',
          DEFAULT: '#c8c8d0',
          dim: '#8a8a97',
          faint: '#5f5f6b',
        },
        // The single accent. Deliberately not green/amber/red: those three are
        // reserved for fit verdicts and must never be confused with a link.
        accent: {
          DEFAULT: '#8b8cf9',
          bright: '#a5a6ff',
          dim: '#6366d6',
          ghost: 'rgba(139, 140, 249, 0.12)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Code', 'JetBrains Mono', 'Consolas', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
};
