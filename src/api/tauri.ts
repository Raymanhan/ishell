import { invoke } from "@tauri-apps/api/core";
import { translateMessage } from "../i18n";

export const isTauri =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

/**
 * A rejected backend command. The backend reports errors in Simplified
 * Chinese; `message` (and therefore `String(error)`) is translated into the
 * UI language, while `raw` keeps the original text for code that recognizes
 * specific backend errors.
 */
export class CommandError extends Error {
  constructor(readonly raw: string) {
    super(translateMessage(raw));
    this.name = "CommandError";
  }
  override toString() {
    return this.message;
  }
}

/** The untranslated backend text of an error, for matching known errors. */
export function rawMessage(error: unknown): string {
  return error instanceof CommandError ? error.raw : String(error);
}

export async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw new CommandError(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}
