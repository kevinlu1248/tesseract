/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0b0d12',
          900: '#11141b',
          850: '#161a23',
          800: '#1c2230',
          700: '#283042',
          600: '#3a4459',
          500: '#566175',
          400: '#7b8699',
          300: '#a6b0c0'
        },
        accent: {
          DEFAULT: '#6ea8fe',
          soft: '#2d4a7a'
        }
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace']
      }
    }
  },
  plugins: []
}
