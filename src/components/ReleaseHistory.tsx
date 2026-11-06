import { useState } from "react";
import { ChevronDown } from "lucide-react";
import chineseChangelog from "../../README.zh-CN.md?raw";
import englishChangelog from "../../README.md?raw";
import { parseReleaseNotes } from "../features/updater/releaseNotes";
import { getLocale, t } from "../i18n";

// Both READMEs carry the same version list; Traditional Chinese reads the
// Chinese notes.
/** Versions shown before "show older versions" is opened. */
export const RECENT_RELEASES = 3;

const releasesByLanguage = {
  zh: parseReleaseNotes(chineseChangelog),
  en: parseReleaseNotes(englishChangelog),
};

function Notes({ text }: { text: string }) {
  return (
    <p className="release-notes">
      {text
        .split(/(`[^`]+`)/g)
        .map((part, index) =>
          part.startsWith("`") && part.endsWith("`") ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </p>
  );
}

export function ReleaseHistory({
  currentVersion,
  update,
}: {
  currentVersion: string | null;
  update: { version: string; notes?: string } | null;
}) {
  const version = (currentVersion || __APP_VERSION__).replace(/^v/, "");
  const releases = releasesByLanguage[getLocale() === "en" ? "en" : "zh"];
  const [showOlder, setShowOlder] = useState(false);
  // The newest releases, plus the installed one when it is older than those.
  const recent = releases.filter(
    (release, index) => index < RECENT_RELEASES || release.version === version,
  );
  const older = releases.filter((release) => !recent.includes(release));
  const item = (release: (typeof releases)[number]) => (
    <details
      key={release.version}
      className="release-history-item"
      open={release.version === version}
    >
      <summary>
        <strong>v{release.version}</strong>
        {release.version === version && (
          <span className="release-current">{t("当前版本")}</span>
        )}
        <span className="release-preview">
          {release.notes.replace(/`/g, "")}
        </span>
        <ChevronDown size={14} />
      </summary>
      <Notes text={release.notes} />
    </details>
  );
  return (
    <section className="release-history" aria-label={t("版本更新历史")}>
      <div className="settings-section-copy">
        <h3>{t("版本更新历史")}</h3>
        <p>{t("最近版本的功能新增、改进与问题修复。")}</p>
      </div>
      {update?.notes?.trim() &&
        update.version.replace(/^v/, "") !== version && (
          <article className="release-upcoming">
            <header>
              <strong>v{update.version.replace(/^v/, "")}</strong>
              <span>{t("可更新")}</span>
            </header>
            <Notes text={update.notes} />
          </article>
        )}
      <div className="release-history-list">
        {recent.map(item)}
        {showOlder && older.length > 0 && (
          <div className="release-history-older">{older.map(item)}</div>
        )}
      </div>
      {older.length > 0 && (
        <button
          type="button"
          className="release-history-more"
          aria-expanded={showOlder}
          onClick={() => setShowOlder((value) => !value)}
        >
          {showOlder
            ? t("收起更早的版本")
            : t("查看更早的 {0} 个版本", older.length)}
          <ChevronDown size={13} />
        </button>
      )}
    </section>
  );
}
