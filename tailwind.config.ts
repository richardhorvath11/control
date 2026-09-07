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
        bg: "#0E0F12",
        surface: "#16181D",
        raised: "#1C1F26",
        border: "#2A2E38",
        text: "#E8EAED",
        muted: "#8B909A",
        amber: "#E8A54B",
        review: "#6B8AFD",
        running: "#3D9A78",
        blocked: "#D15B4A",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      minWidth: {
        desktop: "1200px",
      },
    },
  },
  plugins: [],
};

export default config;
