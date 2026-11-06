import type { IBufferCellPosition, ILinkProvider, Terminal } from "@xterm/xterm";

import { t } from "../../i18n";
const promptPatterns = [
  /^(\s*(?:\([^()\r\n]*\)\s*)*)([\w.-]+)@([^\s:]+):((?:~|\/).*?)[#$%](?=\s|$)/,
  /^(\s*(?:\([^()\r\n]*\)\s*)*)\[([\w.-]+)@([^\s\]]+)\s+((?:~|\/).*?)\]\s*[#$%](?=\s|$)/,
  /^(\s*(?:\([^()\r\n]*\)\s*)*)([\w.-]+)@([^\s:]+)\s+((?:~|\/).*?)\s+[#$%](?=\s|$)/,
];

/** Recognize full paths in common Bash/Zsh prompts, without reading command output as a path. */
export function promptDirectory(text: string) {
  for (const pattern of promptPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const path = match[4].replace(/\s+$/, "");
    if (!/^(?:\/|~(?:[\w.-]+)?(?:\/|$))/.test(path)) continue;
    // A sudo prompt's ~ belongs to its displayed user, not the SSH login user.
    return {
      path: path.replace(/^~(?=\/|$)/, `~${match[2]}`),
      start: match[1].length,
      end: match[0].length,
    };
  }
  return null;
}

export function directoryLinkProvider(
  terminal: Pick<Terminal, "buffer" | "element">,
  onOpen: (path: string) => void,
  mac: boolean,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") return callback(undefined);
      let firstLine = bufferLineNumber - 1;
      while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) firstLine -= 1;

      let text = "";
      const cells: { start: IBufferCellPosition; end: IBufferCellPosition }[] = [];
      // Use cells rather than string offsets: CJK glyphs, emoji, and wrapped
      // prompts occupy a different number of columns than JavaScript characters.
      for (let y = firstLine; y < buffer.length; y += 1) {
        const line = buffer.getLine(y);
        if (!line || (y > firstLine && !line.isWrapped)) break;
        for (let x = 0; x < line.length; x += 1) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          // xterm leaves a blank cell when a wide glyph wraps to the next row.
          if (
            x === line.length - 1 && !cell.getChars() &&
            buffer.getLine(y + 1)?.isWrapped && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2
          ) continue;
          const chars = cell.getChars() || " ";
          text += chars;
          for (let i = 0; i < chars.length; i += 1) {
            cells.push({ start: { x: x + 1, y: y + 1 }, end: { x: x + cell.getWidth(), y: y + 1 } });
          }
        }
        if (text.length > 8192) return callback(undefined);
      }
      const directory = promptDirectory(text.trimEnd());
      if (!directory) return callback(undefined);
      const start = cells[directory.start]?.start;
      const end = cells[directory.end - 1]?.end;
      if (!start || !end || bufferLineNumber > end.y) return callback(undefined);
      const hint = t("{0} + 点击，在文件栏打开 {1}", mac ? "Command" : "Ctrl", directory.path);
      callback([{
        range: { start, end },
        text: text.slice(directory.start, directory.end),
        activate(event) {
          if (event.button !== 0 || event.altKey || !(mac ? event.metaKey : event.ctrlKey)) return;
          event.preventDefault();
          onOpen(directory.path);
        },
        hover() {
          if (terminal.element) terminal.element.title = hint;
        },
        leave() {
          if (terminal.element?.title === hint) terminal.element.removeAttribute("title");
        },
      }]);
    },
  };
}
