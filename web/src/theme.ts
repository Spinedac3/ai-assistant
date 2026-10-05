import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

type Ramp = Record<
  "50" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900",
  string
>;

// The default brand: a violet with a cool, slightly blue tone
const VIOLET: Ramp = {
  50: "#F4F1FE",
  100: "#E8E2FC",
  200: "#D1C6F9",
  300: "#B2A0F3",
  400: "#9379EB",
  500: "#7C5CE4",
  600: "#6A4BD1",
  700: "#5A3EB3",
  800: "#453089",
  900: "#241C52",
};

/**
 * Mixes two hex colors
 *
 * @param   from    Color at weight 0
 * @param   to      Color at weight 1
 * @param   weight  How much of the second color, from 0 to 1
 *
 * @return  The mixed color
 */
function mix(from: string, to: string, weight: number): string {
  const channels = (hex: string) =>
    [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const [a, b] = [channels(from), channels(to)];

  return `#${a
    .map((value, index) =>
      Math.round(value + ((b[index] ?? 0) - value) * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Builds a whole ramp from the one color an installation chooses as its 500
 *
 * @param   base  Hex color
 *
 * @return  The ramp, lighter towards 50 and darker towards 900
 */
export function rampOf(base: string): Ramp {
  return {
    50: mix(base, "#FFFFFF", 0.92),
    100: mix(base, "#FFFFFF", 0.84),
    200: mix(base, "#FFFFFF", 0.66),
    300: mix(base, "#FFFFFF", 0.44),
    400: mix(base, "#FFFFFF", 0.2),
    500: base,
    600: mix(base, "#000000", 0.12),
    700: mix(base, "#000000", 0.26),
    800: mix(base, "#000000", 0.42),
    900: mix(base, "#000000", 0.66),
  };
}

const configured = import.meta.env.VITE_BRAND_COLOR as string | undefined;
const BRAND = configured && /^#[0-9a-fA-F]{6}$/.test(configured) ? rampOf(configured) : VIOLET;

const tokens = (ramp: Ramp) =>
  Object.fromEntries(Object.entries(ramp).map(([step, value]) => [step, { value }]));

const config = defineConfig({
  globalCss: {
    "html, body": { bg: "bg.canvas", color: "fg", fontFeatureSettings: "'cv11'" },
    "::selection": { bg: "brand.200" },
    // Answers come as markdown; the reset leaves them unstyled
    ".markdown": { lineHeight: "1.65" },
    ".markdown > * + *": { marginTop: "0.75em" },
    ".markdown h1, .markdown h2, .markdown h3": { fontFamily: "heading", fontWeight: "semibold" },
    ".markdown h1": { fontSize: "lg" },
    ".markdown h2": { fontSize: "md" },
    ".markdown ul, .markdown ol": { paddingInlineStart: "1.4em" },
    ".markdown ul": { listStyleType: "disc" },
    ".markdown ol": { listStyleType: "decimal" },
    ".markdown a": { color: "brand.fg", textDecoration: "underline" },
    ".markdown code": {
      fontFamily: "mono",
      fontSize: "0.9em",
      bg: "bg.muted",
      px: "1",
      rounded: "sm",
    },
    ".markdown pre": { bg: "bg.muted", p: "3", rounded: "md", overflowX: "auto" },
    ".markdown table": {
      borderCollapse: "collapse",
      fontSize: "sm",
      display: "block",
      overflowX: "auto",
    },
    ".markdown th, .markdown td": {
      borderWidth: "1px",
      borderColor: "border",
      px: "2",
      py: "1",
      textAlign: "left",
    },
    ".markdown th": { bg: "bg.subtle", fontWeight: "semibold" },
    ".markdown td": { fontVariantNumeric: "tabular-nums" },
    "*": {
      _motionReduce: {
        animationDuration: "0.01ms !important",
        transitionDuration: "0.01ms !important",
      },
    },
  },
  theme: {
    tokens: {
      colors: {
        brand: tokens(BRAND),
        // Cool greys of a single family
        neutral: tokens({
          50: "#F7F9FA",
          100: "#EEF1F3",
          200: "#DDE3E6",
          300: "#C2CACF",
          400: "#94A0A6",
          500: "#6B767B",
          600: "#4E585C",
          700: "#374042",
          800: "#242B2C",
          900: "#121617",
        }),
      },
      fonts: {
        heading: { value: "'Space Grotesk Variable', system-ui, sans-serif" },
        body: { value: "'Inter Variable', system-ui, sans-serif" },
        mono: { value: "'JetBrains Mono Variable', ui-monospace, monospace" },
      },
      radii: { control: { value: "9px" }, panel: { value: "12px" } },
      sizes: { control: { value: "38px" } },
      // Shadows tinted with the dark of the brand, never pure black
      shadows: {
        xs: { value: "0 1px 2px rgba(30, 27, 56, 0.04)" },
        sm: { value: "0 1px 3px rgba(30, 27, 56, 0.06), 0 1px 2px rgba(30, 27, 56, 0.04)" },
        md: { value: "0 4px 12px rgba(30, 27, 56, 0.08)" },
        lg: { value: "0 12px 32px rgba(30, 27, 56, 0.12)" },
      },
    },
    semanticTokens: {
      colors: {
        // The color palette every component reads when colorPalette="brand"
        brand: {
          solid: { value: { base: "{colors.brand.500}", _dark: "{colors.brand.400}" } },
          contrast: { value: "white" },
          fg: { value: { base: "{colors.brand.600}", _dark: "{colors.brand.300}" } },
          // In the dark, the deep end of the same ramp, so a configured brand changes these too
          muted: { value: { base: "{colors.brand.100}", _dark: "{colors.brand.800}" } },
          subtle: { value: { base: "{colors.brand.50}", _dark: "{colors.brand.900}" } },
          emphasized: { value: { base: "{colors.brand.200}", _dark: "{colors.brand.700}" } },
          focusRing: { value: "{colors.brand.500}" },
        },
        // Three layers: the canvas, the surfaces on it and the fields inside them
        bg: {
          DEFAULT: { value: { base: "white", _dark: "#1C1B24" } },
          canvas: { value: { base: "{colors.neutral.50}", _dark: "#15141B" } },
          surface: { value: { base: "white", _dark: "#1C1B24" } },
          panel: { value: { base: "white", _dark: "#1C1B24" } },
          subtle: { value: { base: "{colors.neutral.50}", _dark: "#211F2B" } },
          muted: { value: { base: "{colors.neutral.100}", _dark: "#24222E" } },
          field: { value: { base: "#F5F6F9", _dark: "#211F2B" } },
          elevated: { value: { base: "white", _dark: "#302E3D" } },
        },
        fg: {
          DEFAULT: { value: { base: "{colors.neutral.900}", _dark: "#ECEBF3" } },
          muted: { value: { base: "{colors.neutral.600}", _dark: "#A9A6BC" } },
          subtle: { value: { base: "{colors.neutral.500}", _dark: "#7F7C94" } },
        },
        border: {
          DEFAULT: { value: { base: "{colors.neutral.200}", _dark: "#312F3E" } },
          subtle: { value: { base: "{colors.neutral.100}", _dark: "#27252F" } },
          emphasized: { value: { base: "{colors.neutral.300}", _dark: "#403D50" } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
