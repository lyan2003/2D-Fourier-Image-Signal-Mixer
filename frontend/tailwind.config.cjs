/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      colors: {
        pinkLight: '#f3d1ed',
        pinkMed: '#ebb3e5',
        purpleSoft: '#d1c4f6',
      },
      backgroundImage: {
        'gradient-purple': 'linear-gradient(90deg, #f3d1ed, #ebb3e5, #d1c4f6)',
      }
    },
  },
  plugins: [],
}
