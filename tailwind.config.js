/** @type {import('@tailwindcss/postcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: { brand: '#006359' },
      borderRadius: { '2xl': '1rem' },
    },
  },
  plugins: [],
}
