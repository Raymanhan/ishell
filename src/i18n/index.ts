/**
 * Lightweight gettext-style localization.
 *
 * Simplified Chinese source text is the message id, so untranslated strings
 * degrade to the original wording instead of showing a key. Catalogs map that
 * source text to the target language; `{0}`, `{1}` … are positional values.
 * The desktop backend still returns Simplified Chinese messages (errors, risk
 * labels, tool status); `translateMessage` translates them, including messages
 * assembled from templates such as "上下文压缩失败，原记录已保留：{0}".
 */
import en from "./locales/en";
import zhTW from "./locales/zh-TW";

export type Locale = "zh-CN" | "zh-TW" | "en";

export const LOCALES: { code: Locale; name: string }[] = [
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "en", name: "English" },
];

const STORAGE_KEY = "ishell.locale";
const catalogs: Record<Locale, Record<string, string> | null> = {
  "zh-CN": null,
  "zh-TW": zhTW,
  en,
};

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale.code === value);
}

/** Map a BCP 47 tag from the system to the closest supported locale. */
export function matchLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) {
    return /hant|-tw|-hk|-mo/.test(lower) ? "zh-TW" : "zh-CN";
  }
  if (lower.startsWith("en")) return "en";
  return null;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function detectLocale(): Locale {
  // Outside a browser window (unit tests, tooling) use the source language.
  if (typeof window === "undefined") return "zh-CN";
  try {
    const saved = storage()?.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage can be unavailable; fall back to the system language.
  }
  const languages =
    typeof navigator === "undefined"
      ? []
      : [...(navigator.languages || []), navigator.language];
  for (const tag of languages) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  // The app was written for Chinese users first; other systems get English.
  return languages.length ? "en" : "zh-CN";
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

function applyDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
applyDocumentLanguage();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale, persist = true) {
  if (!isLocale(locale)) return;
  if (persist) {
    try {
      storage()?.setItem(STORAGE_KEY, locale);
    } catch {
      // Not persisted; the choice still applies to this window.
    }
  }
  if (locale === current) return;
  current = locale;
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Keep separate windows (log viewer, detached terminals) in the same language.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && isLocale(event.newValue))
      setLocale(event.newValue, false);
  });
}

function format(text: string, args: unknown[]): string {
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (match, index) =>
    Number(index) < args.length ? String(args[Number(index)]) : match,
  );
}

/** Translate UI source text in the current language. */
export function t(source: string, ...args: unknown[]): string {
  return format(catalogs[current]?.[source] ?? source, args);
}

/** Translate into an explicit locale (tests, previews). */
export function translateIn(
  locale: Locale,
  source: string,
  ...args: unknown[]
): string {
  return format(catalogs[locale]?.[source] ?? source, args);
}

interface Template {
  pattern: RegExp;
  /** Placeholder number for each capture group, in order. */
  slots: number[];
  source: string;
}
const templateCache = new Map<Record<string, string>, Template[]>();

function templates(catalog: Record<string, string>): Template[] {
  let list = templateCache.get(catalog);
  if (!list) {
    list = Object.keys(catalog)
      .filter((source) => /\{\d+\}/.test(source))
      // Most literal text first, so "压缩失败：{0}" wins over "{0}：{1}".
      .sort(
        (a, b) =>
          b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length,
      )
      .map((source) => {
        const slots: number[] = [];
        const body = source
          .split(/(\{\d+\})/)
          .map((part) => {
            if (!/^\{\d+\}$/.test(part))
              return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            slots.push(Number(part.slice(1, -1)));
            return "([\\s\\S]*?)";
          })
          .join("");
        return { source, slots, pattern: new RegExp(`^${body}$`) };
      });
    templateCache.set(catalog, list);
  }
  return list;
}

/**
 * Translate a message produced by the backend (or stored earlier) that may be
 * a catalog entry, a filled-in template, or text that must stay as is (server
 * output, file names). Captured values are translated recursively, so nested
 * errors such as "压缩失败：{0}" with an inner known message are covered.
 */
export function translateMessage(
  text: string,
  locale: Locale = current,
  depth = 0,
): string {
  const catalog = catalogs[locale];
  if (!catalog || !text || depth > 4) return text;
  const exact = catalog[text];
  if (exact !== undefined) return exact;
  const trimmed = text.trim();
  if (trimmed !== text && catalog[trimmed] !== undefined)
    return text.replace(trimmed, catalog[trimmed]);
  // Only messages that contain CJK text can be backend messages.
  if (!/[㐀-鿿]/.test(text) || text.length > 4000) return text;
  for (const { pattern, slots, source } of templates(catalog)) {
    const match = pattern.exec(text);
    if (!match) continue;
    const values: string[] = [];
    slots.forEach((slot, group) => {
      values[slot] ??= translateMessage(
        match[group + 1] ?? "",
        locale,
        depth + 1,
      );
    });
    return format(catalog[source], values);
  }
  return text;
}

/** Locale-aware date/time formatting for the current language. */
export function formatDateTime(
  value: number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(current, options).format(value);
}

export function formatDate(value: number | Date): string {
  return new Intl.DateTimeFormat(current, { dateStyle: "medium" }).format(
    value,
  );
}

/**
 * Mark source text that is translated later with `t(value)` (module-level
 * constants). Returns the text unchanged; the catalog extractor collects it.
 */
export function msg<T extends string>(source: T): T {
  return source;
}
