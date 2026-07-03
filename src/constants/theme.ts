import type { ITheme } from "@xterm/xterm";

export const swatches = ["#5b9dff", "#43c98b", "#f2b45a", "#f56b6b", "#b18cff", "#46c7c7"];

export type AppTheme = "glass" | "liquid-glass";
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

export const appThemeOrder = ["glass", "liquid-glass"] as const satisfies readonly AppTheme[];

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
