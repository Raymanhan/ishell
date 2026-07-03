import type { ITheme } from "@xterm/xterm";

export const swatches = ["#5b9dff", "#43c98b", "#f2b45a", "#f56b6b", "#b18cff", "#46c7c7"];

export type AppTheme =
  | "glass"
  | "liquid-glass"
  | "liquid-glass-aurora"
  | "liquid-glass-coral"
  | "liquid-glass-lagoon"
  | "liquid-glass-amethyst"
  | "liquid-glass-onyx"
  | "liquid-glass-pearl";
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
  "glass",
  "liquid-glass",
  "liquid-glass-aurora",
  "liquid-glass-coral",
  "liquid-glass-lagoon",
  "liquid-glass-amethyst",
  "liquid-glass-onyx",
  "liquid-glass-pearl",
] as const satisfies readonly AppTheme[];

export const appThemeDefinitions = {
  glass: {
    id: "glass",
    label: "玻璃灰",
    icon: "layers",
    previewClassName: "glass",
    terminal: {
      background: "#00000000",
      foreground: "#f2f4f7",
      cursor: "#c9d7ff",
      selectionBackground: "rgba(201, 215, 255, 0.28)",
      black: "#17191d",
      red: "#ff8f9d",
      green: "#9ee6b8",
      yellow: "#f7d58c",
      blue: "#a9c8ff",
      magenta: "#d5bbff",
      cyan: "#9ae7e0",
      white: "#f6f7f9",
    },
    native: {
      backgroundColor: { red: 74, green: 82, blue: 93, alpha: 46 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass": {
    id: "liquid-glass",
    label: "液态玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass",
    terminal: {
      background: "#00000000",
      foreground: "#f7fbff",
      cursor: "#dbf7ff",
      selectionBackground: "rgba(145, 220, 255, 0.3)",
      black: "#10151b",
      red: "#ff9aa7",
      green: "#a9f0c5",
      yellow: "#ffe08a",
      blue: "#9edcff",
      magenta: "#dac1ff",
      cyan: "#8ff5ee",
      white: "#fbfdff",
    },
    native: {
      backgroundColor: { red: 35, green: 47, blue: 58, alpha: 34 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-aurora": {
    id: "liquid-glass-aurora",
    label: "极光玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-aurora",
    terminal: {
      background: "#00000000",
      foreground: "#f3fff8",
      cursor: "#b9ffd6",
      selectionBackground: "rgba(127, 255, 184, 0.28)",
      black: "#0d1715",
      red: "#ff9fb2",
      green: "#9df8bd",
      yellow: "#f4ea91",
      blue: "#8ddcff",
      magenta: "#c9b3ff",
      cyan: "#86f6df",
      white: "#fbfffd",
    },
    native: {
      backgroundColor: { red: 28, green: 52, blue: 45, alpha: 36 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-coral": {
    id: "liquid-glass-coral",
    label: "珊瑚玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-coral",
    terminal: {
      background: "#00000000",
      foreground: "#fff8f5",
      cursor: "#ffd4bf",
      selectionBackground: "rgba(255, 163, 127, 0.28)",
      black: "#1a1210",
      red: "#ff9a9a",
      green: "#b7edb3",
      yellow: "#ffd48b",
      blue: "#9fd8ff",
      magenta: "#ffc2df",
      cyan: "#91eadf",
      white: "#fffdfb",
    },
    native: {
      backgroundColor: { red: 78, green: 45, blue: 38, alpha: 36 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-lagoon": {
    id: "liquid-glass-lagoon",
    label: "泻湖玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-lagoon",
    terminal: {
      background: "#00000000",
      foreground: "#f2fffd",
      cursor: "#9df7ef",
      selectionBackground: "rgba(73, 223, 208, 0.28)",
      black: "#0a1719",
      red: "#ff9ba8",
      green: "#aaf2be",
      yellow: "#f5df8c",
      blue: "#8ccfff",
      magenta: "#d3b9ff",
      cyan: "#79f2e9",
      white: "#fbfffe",
    },
    native: {
      backgroundColor: { red: 22, green: 58, blue: 66, alpha: 36 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-amethyst": {
    id: "liquid-glass-amethyst",
    label: "紫晶玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-amethyst",
    terminal: {
      background: "#00000000",
      foreground: "#fbf7ff",
      cursor: "#e4c7ff",
      selectionBackground: "rgba(212, 165, 255, 0.28)",
      black: "#17111d",
      red: "#ff9fb7",
      green: "#b6efc4",
      yellow: "#f6df93",
      blue: "#abbcff",
      magenta: "#ddaaff",
      cyan: "#92e8ee",
      white: "#fffbff",
    },
    native: {
      backgroundColor: { red: 51, green: 38, blue: 74, alpha: 36 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-onyx": {
    id: "liquid-glass-onyx",
    label: "柔黑玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-onyx",
    terminal: {
      background: "#00000000",
      foreground: "#f7f8f8",
      cursor: "#d8dcde",
      selectionBackground: "rgba(216, 220, 222, 0.26)",
      black: "#101112",
      red: "#f2a2a8",
      green: "#b6e3c1",
      yellow: "#e9d69a",
      blue: "#aec7e8",
      magenta: "#d6bee8",
      cyan: "#a9dcdb",
      white: "#fbfbfa",
    },
    native: {
      backgroundColor: { red: 24, green: 25, blue: 26, alpha: 38 },
      transparentChrome: true,
      effect: "glass",
    },
  },
  "liquid-glass-pearl": {
    id: "liquid-glass-pearl",
    label: "柔白玻璃",
    icon: "droplets",
    previewClassName: "liquid-glass liquid-glass-pearl",
    terminal: {
      background: "#00000000",
      foreground: "#2a3034",
      cursor: "#596873",
      selectionBackground: "rgba(126, 146, 158, 0.24)",
      black: "#1f2529",
      red: "#bf5f68",
      green: "#4d8d68",
      yellow: "#a17c32",
      blue: "#4f7aa6",
      magenta: "#866aa8",
      cyan: "#4d8f8b",
      white: "#f8f5ef",
    },
    native: {
      backgroundColor: { red: 236, green: 233, blue: 225, alpha: 42 },
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
