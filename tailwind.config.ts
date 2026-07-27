import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#15221C",
        slate: "#566A61",
        line: "#E0E7E2",
        paper: "#F6F8F5",
        chalk: "#FFFFFF",
        marker: "#0E5A3C", // pine 700 — primary
        markerDark: "#0A4530", // pine 800 — hover/pressed
        markerSoft: "#E4F0EA", // pine 100 — tints, published badge
        brass: "#C88A1C", // accent fills + the AI generate moment
        brassText: "#9C6A11", // accent as text (contrast-safe)
        brassSoft: "#FAF0D8", // draft badge, gentle highlight
        success: "#1E8A5C",
        flag: "#B23F27", // error/destructive
        flagSoft: "#FBEBE6",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      maxWidth: { readable: "68ch" },
    },
  },
  plugins: [],
} satisfies Config;
