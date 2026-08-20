import type { Config } from "tailwindcss";

/**
 * The ilumo design tokens. See docs/ilumo-brand.md for the full spec, the
 * measured contrast ratios, and the rule a contributor breaks first.
 *
 * THE RULE: `accent` and `success` are the logo colours at logo brightness, and
 * they are FILLS ONLY - 2.86:1 and 1.52:1 on white. Any text or icon on a light
 * background uses `accentText` / `successText` instead. Every value below is
 * checked by scripts/check-contrast.ts, which runs in `npm run check:brand`.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand - indigo, the intersection of the two shapes in the mark.
        brand: "#3852D6", // 6.28:1 on white, and 6.28:1 white-on. Primary action.
        brandHover: "#2F45B8", // 7.88:1 - hover and pressed
        brandSoft: "#EEF1FD", // tinted surface
        brandRing: "#93A4EE", // focus ring on brand-filled controls

        // Accent - azure. Links, information, and the AI generate moment.
        accent: "#3E9BFF", // FILL ONLY - 2.86:1 on white
        accentText: "#0F62C4", // 5.89:1 - link and info text
        accentSoft: "#EAF4FF",

        // Success - mint. Published, saved, finalised. Kept rare on purpose.
        success: "#5FE9B2", // FILL ONLY - 1.52:1 on white, 11.21:1 under ink
        successText: "#0E7A55", // 5.34:1
        successSoft: "#E6FBF2",

        // Neutrals
        ink: "#1A1C1F", // 17.08:1 - body text, and the wordmark black
        muted: "#5B6470", // 6.00:1 - secondary text
        line: "#E4E7EC", // decorative separators - card edges, dividers
        lineStrong: "#CFD4DC", // decorative, one step up - hover edges, dashed drop zones
        /**
         * The border that says "this is an input".
         *
         * Darker than it may look necessary because WCAG 1.4.11 requires 3:1 for
         * the boundary that identifies a control, and a hairline grey fails it
         * (lineStrong is 1.49:1). This is 3.62:1 on surface and 3.41:1 on canvas.
         * It also survives direct sunlight on a cheap screen, which is the real
         * test here. Verified by scripts/check-contrast.ts.
         */
        lineInput: "#7E8796",
        surface: "#FFFFFF",
        canvas: "#F7F8FA",

        // Status colours deliberately outside the logo palette: a warning that
        // borrowed a brand colour would stop reading as a warning.
        warn: "#B45309", // 4.87:1
        warnSoft: "#FEF6E7",
        danger: "#B42318", // 6.24:1
        dangerSoft: "#FEF3F2",
      },

      fontFamily: {
        // Headings, the wordmark, and numerals.
        display: ["var(--font-display)", "var(--font-body)", "system-ui", "sans-serif"],
        // Body stays on the system stack: zero bytes, instant first paint.
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
      },

      /**
       * Semantic type scale. The negative tracking at large sizes is most of what
       * separates set type from default type - default browser tracking is drawn
       * for body copy and looks loose at heading sizes.
       */
      fontSize: {
        eyebrow: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.06em" }],
        display: ["2.25rem", { lineHeight: "1.1", letterSpacing: "-0.03em" }],
        title: ["1.75rem", { lineHeight: "1.2", letterSpacing: "-0.022em" }],
        heading: ["1.25rem", { lineHeight: "1.3", letterSpacing: "-0.015em" }],
        subheading: ["1.0625rem", { lineHeight: "1.4", letterSpacing: "-0.008em" }],
      },

      maxWidth: {
        readable: "68ch", // lesson prose - measure, not layout
        app: "64rem", // dashboards and the landing page
      },

      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
        lift: "0 2px 4px rgba(16,24,40,0.04), 0 8px 20px rgba(16,24,40,0.08)",
        // A brand-tinted shadow, so the primary button sits in the palette
        // rather than under a grey cloud.
        brand: "0 1px 2px rgba(56,82,214,0.24), 0 4px 12px rgba(56,82,214,0.16)",
      },

      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
