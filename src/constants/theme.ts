import type { ITheme } from "@xterm/xterm";

export const swatches = ["#5b9dff", "#43c98b", "#f2b45a", "#f56b6b", "#b18cff", "#46c7c7"];

export type AppTheme =
  | "glass"
  | "liquid-glass"
  | "liquid-glass-lagoon"
  | "liquid-glass-onyx"
  | "liquid-glass-pearl"
  | "liquid-glass-cloud"
  | "liquid-glass-dusk"
  | "liquid-glass-clay"
  | "liquid-glass-clay-light";
export type ThemeIcon = "layers" | "droplets";

export interface NativeColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface NativeTheme {
  backgroundColor: NativeColor;
  transparentChrome: boolean;
  effect: "glass" | "none";
}

export interface AppThemeDefinition {
  id: AppTheme;
  label: string;
  icon: ThemeIcon;
  previewClassName: string;
  terminal: ITheme;
  native: NativeTheme;
}

export const defaultAppTheme: AppTheme = "glass";

export const appThemeOrder = [
  "liquid-glass-cloud",
  "liquid-glass-dusk",
  "liquid-glass-clay",
  "liquid-glass-clay-light",
  "glass",
  "liquid-glass",
  "liquid-glass-lagoon",
  "liquid-glass-onyx",
  "liquid-glass-pearl",
] as const satisfies readonly AppTheme[];

// Theme ids are persisted in localStorage, so they keep their original names;
// the labels and palettes are what users see.
//
// Each terminal palette is a full 16-color set tuned to its theme: muted,
// evenly weighted hues that stay legible on the translucent background.
export const appThemeDefinitions = {
  glass: {
    id: "glass",
    label: "石墨灰",
    icon: "layers",
    previewClassName: "glass",
    terminal: {
      background: "#00000000",
      foreground: "#f2f4f7",
      cursor: "#b4c0d8",
      cursorAccent: "#1c1e22",
      selectionBackground: "rgba(180, 192, 216, 0.26)",
      black: "#1c1e22",
      red: "#ff8a94",
      green: "#84dc9c",
      yellow: "#f2cc7a",
      blue: "#86b4ff",
      magenta: "#cfa6ff",
      cyan: "#7fd8d4",
      white: "#e3e6eb",
      brightBlack: "#6c727c",
      brightRed: "#ffa6ae",
      brightGreen: "#a3e8b5",
      brightYellow: "#f8dc9c",
      brightBlue: "#a8c8ff",
      brightMagenta: "#dcbcff",
      brightCyan: "#a0e6e2",
      brightWhite: "#ffffff",
    },
    native: {
      backgroundColor: { red: 48, green: 50, blue: 55, alpha: 46 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass": {
    id: "liquid-glass",
    label: "午夜蓝",
    icon: "droplets",
    previewClassName: "liquid-glass",
    terminal: {
      background: "#00000000",
      foreground: "#f4f2ed",
      cursor: "#d8bf8e",
      cursorAccent: "#141a2a",
      selectionBackground: "rgba(216, 191, 142, 0.24)",
      black: "#141a2a",
      red: "#ff8a8f",
      green: "#8fdca2",
      yellow: "#f2cf86",
      blue: "#86b2ff",
      magenta: "#cfa8ff",
      cyan: "#84d6e2",
      white: "#e2e4ec",
      brightBlack: "#66708c",
      brightRed: "#ffa8ac",
      brightGreen: "#aee8bc",
      brightYellow: "#f8dea6",
      brightBlue: "#a8c8ff",
      brightMagenta: "#dcbfff",
      brightCyan: "#a6e4ec",
      brightWhite: "#fbfaf6",
    },
    native: {
      backgroundColor: { red: 18, green: 24, blue: 40, alpha: 38 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-lagoon": {
    id: "liquid-glass-lagoon",
    label: "墨玉绿",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-lagoon",
    terminal: {
      background: "#00000000",
      foreground: "#eef6f1",
      cursor: "#9fd4bc",
      cursorAccent: "#0f1e1b",
      selectionBackground: "rgba(159, 212, 188, 0.24)",
      black: "#0f1e1b",
      red: "#ff8c8a",
      green: "#8fe0a0",
      yellow: "#f0d184",
      blue: "#84c0ec",
      magenta: "#d0aee8",
      cyan: "#7fe0cc",
      white: "#e0eae4",
      brightBlack: "#5f7a72",
      brightRed: "#ffa9a7",
      brightGreen: "#adeabb",
      brightYellow: "#f6dfa6",
      brightBlue: "#a6d2f2",
      brightMagenta: "#dec4ee",
      brightCyan: "#a2eadb",
      brightWhite: "#f8fcf9",
    },
    native: {
      backgroundColor: { red: 14, green: 32, blue: 29, alpha: 38 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-onyx": {
    id: "liquid-glass-onyx",
    label: "曜石黑",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-onyx",
    terminal: {
      background: "#00000000",
      foreground: "#f3f0ea",
      cursor: "#e6dfd2",
      cursorAccent: "#141414",
      selectionBackground: "rgba(230, 223, 210, 0.22)",
      black: "#141414",
      red: "#ff8c80",
      green: "#9ad690",
      yellow: "#f0cf86",
      blue: "#94bde8",
      magenta: "#d6aed6",
      cyan: "#8fd6c9",
      white: "#e4e0d8",
      brightBlack: "#6b6862",
      brightRed: "#ffaaa0",
      brightGreen: "#b6e2ae",
      brightYellow: "#f6dea6",
      brightBlue: "#b0cfee",
      brightMagenta: "#e2c4e2",
      brightCyan: "#aee2d8",
      brightWhite: "#faf8f3",
    },
    native: {
      backgroundColor: { red: 20, green: 20, blue: 21, alpha: 40 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-pearl": {
    id: "liquid-glass-pearl",
    label: "象牙白",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-pearl",
    terminal: {
      background: "#00000000",
      foreground: "#2b2f35",
      cursor: "#3a5a7c",
      cursorAccent: "#fbf9f4",
      selectionBackground: "rgba(58, 90, 124, 0.18)",
      black: "#2b2f35",
      red: "#b04a50",
      green: "#4a7d52",
      yellow: "#94701e",
      blue: "#3a62a0",
      magenta: "#85579a",
      cyan: "#2f7d80",
      // On a light ground "white" must stay visible, so it maps to a warm gray.
      white: "#8a8b8f",
      brightBlack: "#6d727a",
      brightRed: "#c4636a",
      brightGreen: "#5e9468",
      brightYellow: "#ad8735",
      brightBlue: "#5279b5",
      brightMagenta: "#9a6daf",
      brightCyan: "#449497",
      brightWhite: "#a9a8a4",
    },
    native: {
      backgroundColor: { red: 240, green: 236, blue: 228, alpha: 46 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-cloud": {
    id: "liquid-glass-cloud",
    label: "云雾白",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-cloud",
    // Soft pastels in the spirit of Otty: gentle enough to feel airy on a
    // white card, deep enough that normal colors stay readable as text.
    terminal: {
      background: "#00000000",
      foreground: "#4c4f69",
      cursor: "#7287fd",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(114, 135, 253, 0.2)",
      black: "#5c5f77",
      red: "#e06c8a",
      green: "#4fa35a",
      yellow: "#c98a1e",
      blue: "#5f7fe8",
      magenta: "#a46ee0",
      cyan: "#2f9e9a",
      white: "#a8abba",
      brightBlack: "#8c8fa1",
      brightRed: "#f38ba8",
      brightGreen: "#7cc47f",
      brightYellow: "#e5b45a",
      brightBlue: "#89a2f5",
      brightMagenta: "#c49cf0",
      brightCyan: "#6cc5c0",
      brightWhite: "#ccd0da",
    },
    native: {
      backgroundColor: { red: 240, green: 240, blue: 243, alpha: 46 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-dusk": {
    id: "liquid-glass-dusk",
    label: "暮霭紫",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-dusk",
    terminal: {
      background: "#00000000",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "rgba(180, 190, 254, 0.22)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f5a3b8",
      brightGreen: "#b8e8b4",
      brightYellow: "#fae8be",
      brightBlue: "#a1c3fb",
      brightMagenta: "#cba6f7",
      brightCyan: "#a8e8de",
      brightWhite: "#e6e9f7",
    },
    native: {
      backgroundColor: { red: 24, green: 24, blue: 36, alpha: 40 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-clay": {
    id: "liquid-glass-clay",
    label: "Claude 深色",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-clay",
    // Claude Code desktop, dark: ivory text on charcoal, the clay-orange cursor
    // (the CLI's spinner color) and blue selection like the app's focus state.
    terminal: {
      background: "#00000000",
      foreground: "#f3f1ea",
      cursor: "#d97757",
      cursorAccent: "#262624",
      selectionBackground: "rgba(92, 156, 245, 0.26)",
      black: "#3a3936",
      red: "#ff8088",
      green: "#86d690",
      yellow: "#f2c46e",
      blue: "#8fa8ff",
      magenta: "#e095d0",
      cyan: "#7fd0c2",
      white: "#e0ddd3",
      brightBlack: "#6f6c66",
      brightRed: "#ff9ea4",
      brightGreen: "#a6e2ad",
      brightYellow: "#f6d494",
      brightBlue: "#b1befc",
      brightMagenta: "#eab0dd",
      brightCyan: "#a0dcd1",
      brightWhite: "#f8f7f3",
    },
    native: {
      backgroundColor: { red: 31, green: 30, blue: 29, alpha: 42 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-clay-light": {
    id: "liquid-glass-clay-light",
    label: "Claude 浅色",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-clay-light",
    // Claude Code desktop, light: near-black on white, the clay-orange cursor
    // and the CLI's light-mode status hues. "white" maps to a gray so it stays
    // visible.
    terminal: {
      background: "#00000000",
      foreground: "#1f1e1d",
      cursor: "#d97757",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(46, 125, 230, 0.18)",
      black: "#1f1e1d",
      red: "#b8434f",
      green: "#3f7f45",
      yellow: "#9a6d1c",
      blue: "#4f5fd6",
      magenta: "#a64d8f",
      cyan: "#2f7f78",
      white: "#8a887f",
      brightBlack: "#73726c",
      brightRed: "#cc5a63",
      brightGreen: "#57955b",
      brightYellow: "#b5852f",
      brightBlue: "#6f7ff0",
      brightMagenta: "#bf68a8",
      brightCyan: "#46978f",
      brightWhite: "#a3a198",
    },
    native: {
      backgroundColor: { red: 246, green: 245, blue: 242, alpha: 46 },
      transparentChrome: true,
      effect: "glass",
    },
  },
} satisfies Record<AppTheme, AppThemeDefinition>;

export function getThemeDefinition(theme: AppTheme) {
  return appThemeDefinitions[theme];
}

export function getTerminalTheme(theme: AppTheme) {
  return getThemeDefinition(theme).terminal;
}

export function readSavedTheme(value: string | null): AppTheme {
  return appThemeOrder.includes(value as AppTheme) ? (value as AppTheme) : defaultAppTheme;
}
