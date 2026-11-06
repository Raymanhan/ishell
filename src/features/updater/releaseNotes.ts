export interface ReleaseNote {
  version: string;
  notes: string;
}

/** The same README section feeds the app and the signed updater manifest. */
export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const entries: ReleaseNote[] = [];
  let inSection = false;
  let current: ReleaseNote[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## (?:最近更新|Recent Changes)\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,2}\s/.test(line)) break;
    const match = line.match(
      /^-\s+((?:`v\d+\.\d+\.\d+`(?:\s*\/\s*)?)+)\s+(.+)$/,
    );
    if (match) {
      current = Array.from(
        match[1].matchAll(/`v(\d+\.\d+\.\d+)`/g),
        (item) => ({ version: item[1], notes: match[2].trim() }),
      );
      entries.push(...current);
    } else if (/^\s+\S/.test(line)) {
      for (const entry of current) entry.notes += ` ${line.trim()}`;
    } else if (line.trim()) current = [];
  }
  return entries
    .filter(
      (entry, index) =>
        entries.findIndex((item) => item.version === entry.version) === index,
    )
    .sort((a, b) => {
      const left = a.version.split(".").map(Number);
      const right = b.version.split(".").map(Number);
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    });
}
