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
  | "liquid-glass-clay";
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
      foreground: "#e8eaee",
      cursor: "#b4c0d8",
      cursorAccent: "#1c1e22",
      selectionBackground: "rgba(180, 192, 216, 0.26)",
      black: "#1c1e22",
      red: "#e0868c",
      green: "#9cc9a0",
      yellow: "#dcc08a",
      blue: "#8fb0db",
      magenta: "#bea2d8",
      cyan: "#8cc4c4",
      white: "#d8dbe0",
      brightBlack: "#636871",
      brightRed: "#eda0a5",
      brightGreen: "#b4d9b6",
      brightYellow: "#ebd3a3",
      brightBlue: "#aac4e8",
      brightMagenta: "#cfb8e5",
      brightCyan: "#a6d6d4",
      brightWhite: "#f4f5f7",
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
      foreground: "#e9e7e2",
      cursor: "#d8bf8e",
      cursorAccent: "#141a2a",
      selectionBackground: "rgba(216, 191, 142, 0.24)",
      black: "#141a2a",
      red: "#e58e8e",
      green: "#9fcba5",
      yellow: "#dec48e",
      blue: "#8eaee6",
      magenta: "#c3a6e0",
      cyan: "#8dc5cf",
      white: "#dcdee5",
      brightBlack: "#5a6480",
      brightRed: "#f0a8a8",
      brightGreen: "#b8ddbd",
      brightYellow: "#ebd6a8",
      brightBlue: "#a9c3f0",
      brightMagenta: "#d4bdeb",
      brightCyan: "#a8d7df",
      brightWhite: "#f5f4f0",
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
      foreground: "#e4ede7",
      cursor: "#9fd4bc",
      cursorAccent: "#0f1e1b",
      selectionBackground: "rgba(159, 212, 188, 0.24)",
      black: "#0f1e1b",
      red: "#e39290",
      green: "#a3d3a8",
      yellow: "#ddc88e",
      blue: "#8fb7d6",
      magenta: "#c4a9d6",
      cyan: "#8ed0c2",
      white: "#d9e3dd",
      brightBlack: "#536a63",
      brightRed: "#efaba9",
      brightGreen: "#bce2c0",
      brightYellow: "#ebd9a9",
      brightBlue: "#a9cae3",
      brightMagenta: "#d4bee3",
      brightCyan: "#a9ded3",
      brightWhite: "#f3f7f4",
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
      foreground: "#e9e6e0",
      cursor: "#e6dfd2",
      cursorAccent: "#141414",
      selectionBackground: "rgba(230, 223, 210, 0.22)",
      black: "#141414",
      red: "#db8f87",
      green: "#a6c49a",
      yellow: "#d9c08c",
      blue: "#96afcb",
      magenta: "#c2a5c2",
      cyan: "#95c2ba",
      white: "#dcd8d0",
      brightBlack: "#5f5c57",
      brightRed: "#e8a9a2",
      brightGreen: "#bdd4b2",
      brightYellow: "#e6d1a6",
      brightBlue: "#afc3da",
      brightMagenta: "#d2bbd2",
      brightCyan: "#aed3cc",
      brightWhite: "#f6f4ef",
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
    label: "陶土橙",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-clay",
    // Claude Code-style: warm ivory text on charcoal, a clay-orange cursor and
    // the CLI's own accents (lavender, mint, amber, rose) softened slightly.
    terminal: {
      background: "#00000000",
      foreground: "#ece9e0",
      cursor: "#d97757",
      cursorAccent: "#262624",
      selectionBackground: "rgba(217, 119, 87, 0.28)",
      black: "#3a3936",
      red: "#e9787e",
      green: "#8fc48a",
      yellow: "#e5b567",
      blue: "#9aa8f0",
      magenta: "#d48fc4",
      cyan: "#7fbfb3",
      white: "#d6d3c9",
      brightBlack: "#6b6963",
      brightRed: "#f2959a",
      brightGreen: "#a8d4a3",
      brightYellow: "#edc788",
      brightBlue: "#b1b9f9",
      brightMagenta: "#e2a9d5",
      brightCyan: "#9cd0c6",
      brightWhite: "#f5f4ef",
    },
    native: {
      backgroundColor: { red: 31, green: 30, blue: 29, alpha: 42 },
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
