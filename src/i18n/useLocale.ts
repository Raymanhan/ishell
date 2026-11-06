import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, type Locale } from ".";

/**
 * Re-render the calling component when the language changes. The app root
 * calls it so the whole tree updates; memoized components that skip parent
 * renders must call it themselves.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
