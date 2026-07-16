export const TAIL_VIEWER_DEFAULT_LINES_KEY = "ishell.tailViewerDefaultLines";
export const DEFAULT_TAIL_VIEWER_LINES = 200;
export const MIN_TAIL_VIEWER_LINES = 10;
export const MAX_TAIL_VIEWER_LINES = 10_000;

export function clampTailViewerLines(value: number) {
  return Math.min(
    MAX_TAIL_VIEWER_LINES,
    Math.max(MIN_TAIL_VIEWER_LINES, Math.round(value)),
  );
}

export function readSavedTailViewerLines(value: string | null) {
  if (value === null || value.trim() === "") return DEFAULT_TAIL_VIEWER_LINES;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? clampTailViewerLines(parsed)
    : DEFAULT_TAIL_VIEWER_LINES;
}
