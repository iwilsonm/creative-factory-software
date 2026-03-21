/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', '"DM Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        navy: {
          DEFAULT: '#0B1D3A',
          light: '#132B52',
          mid: '#1A3A6B',
        },
        gold: {
          DEFAULT: '#C4975A',
          light: '#D4AA6A',
        },
        teal: {
          DEFAULT: '#2A9D8F',
        },
        offwhite: '#FAFAF8',
        cream: '#F4F1EB',
        textdark: '#1A1A2E',
        textmid: '#4A5568',
        textlight: '#8A96A8',
        darkbg: '#0F172A',
        darkcard: '#1E293B',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        'card': '0 4px 24px rgba(0, 0, 0, 0.06)',
        'card-hover': '0 8px 32px rgba(0, 0, 0, 0.08)',
        'gold': '0 4px 20px rgba(196, 151, 90, 0.35)',
        'gold-sm': '0 2px 10px rgba(196, 151, 90, 0.25)',
        'nav': '0 1px 4px rgba(0, 0, 0, 0.03)',
        'pill': '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04)',
      },
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: 0, transform: 'translateY(12px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(196, 151, 90, 0.4)' },
          '50%': { boxShadow: '0 0 0 4px rgba(196, 151, 90, 0.1)' },
        }
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.4s ease-out forwards',
        'pulse-glow': 'pulse-glow 2s infinite',
      }
    }
  },
  plugins: []
};
