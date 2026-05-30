import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gold: {
          50: "#FAF7E9",
          100: "#F3EBC5",
          200: "#E6D48C",
          300: "#D4B953",
          400: "#C49D2B",
          500: "#D4AF37", // Oro metálico primario
          600: "#B89429",
          700: "#8F701E",
          800: "#664E15",
          900: "#3D2E0B",
          950: "#1F1705",
        },
        dark: {
          950: "#0B0B0B", // Fondo profundo
          900: "#141414", // Tarjetas y paneles
          800: "#1D1D1D", // Bordes suaves e inputs
          700: "#2B2B2B", // Bordes resaltados
          600: "#444444", // Textos secundarios
        }
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-gold": "pulse-gold 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        "pulse-gold": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: ".8", transform: "scale(1.01)" },
        }
      }
    },
  },
  plugins: [],
};
export default config;
