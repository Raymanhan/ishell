import { ChevronDown } from "lucide-react";
import changelog from "../../README.zh-CN.md?raw";
import { parseReleaseNotes } from "../features/updater/releaseNotes";

const releases = parseReleaseNotes(changelog);

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
  return (
    <section className="release-history" aria-label="版本更新历史">
      <div className="settings-section-copy">
        <h3>版本更新历史</h3>
        <p>按版本查看功能新增、改进与问题修复。</p>
      </div>
      {update?.notes?.trim() &&
        update.version.replace(/^v/, "") !== version && (
          <article className="release-upcoming">
            <header>
              <strong>v{update.version.replace(/^v/, "")}</strong>
              <span>可更新</span>
            </header>
            <Notes text={update.notes} />
          </article>
        )}
      <div className="release-history-list">
        {releases.map((release) => (
          <details
            key={release.version}
            className="release-history-item"
            open={release.version === version}
          >
            <summary>
              <strong>v{release.version}</strong>
              {release.version === version && (
                <span className="release-current">当前版本</span>
              )}
              <span className="release-preview">
                {release.notes.replace(/`/g, "")}
              </span>
              <ChevronDown size={14} />
            </summary>
            <Notes text={release.notes} />
          </details>
        ))}
      </div>
    </section>
  );
}
