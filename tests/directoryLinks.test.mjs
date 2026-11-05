import assert from "node:assert/strict";
import test from "node:test";
import { directoryLinkProvider, promptDirectory } from "../src/features/shell/directoryLinks.ts";

test("recognizes home, absolute paths, spaces, and common Bash/Zsh prompts", () => {
  for (const [prompt, path] of [
    ["ubuntu@VM-0-10-ubuntu:~$ ", "~ubuntu"],
    ["root@host:~/logs# tail app.log", "~root/logs"],
    ["user@host:/var/log$ ls", "/var/log"],
    ["(venv) user@host:/tmp/中文 folder$ ", "/tmp/中文 folder"],
    ["[user@host /var/log]$ ", "/var/log"],
    ["user@host ~/projects % ", "~user/projects"],
    ["user@host:~other/notes$ ", "~other/notes"],
    ["user@host:/$ ", "/"],
  ]) {
    assert.equal(promptDirectory(prompt)?.path, path, prompt);
  }
});

test("does not invent directories from commands, logs, or abbreviated basenames", () => {
  for (const text of ["$ cd /tmp", "log: user@host:/tmp$", "user@host project %", "Password: ", "user@host:~+ $", "user@host:~/file"])
    assert.equal(promptDirectory(text), null, text);
});

function fakeTerminal(text, cols = 80) {
  const lines = [];
  let cells = [];
  let wrapped = false;
  const flush = () => {
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    const row = cells;
    lines.push({
      isWrapped: wrapped,
      length: row.length,
      getCell: (x) => row[x] && ({ getChars: () => row[x].chars, getWidth: () => row[x].width }),
    });
    cells = [];
    wrapped = true;
  };
  for (const char of text) {
    if (/\p{Mark}/u.test(char)) {
      const previous = cells.findLast((cell) => cell.width > 0);
      previous.chars += char;
      continue;
    }
    const width = /[\u2e80-\u9fff]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
    if (cells.length + width > cols) flush();
    cells.push({ chars: char, width });
    if (width === 2) cells.push({ chars: "", width: 0 });
  }
  flush();
  return { element: undefined, buffer: { active: { type: "normal", length: lines.length, getLine: (y) => lines[y] } } };
}

function linksFor(terminal, onOpen = () => {}, mac = true, row = 1) {
  let links;
  directoryLinkProvider(terminal, onOpen, mac).provideLinks(row, (result) => { links = result; });
  return links;
}

test("only the platform modifier plus primary click opens the directory", () => {
  for (const mac of [true, false]) {
    const paths = [];
    const [link] = linksFor(fakeTerminal("user@host:~/dir$ ls"), (path) => paths.push(path), mac);
    const event = { button: 0, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} };
    link.activate(event);
    link.activate({ ...event, metaKey: !mac, ctrlKey: mac });
    link.activate({ ...event, metaKey: mac, ctrlKey: !mac, button: 1 });
    link.activate({ ...event, metaKey: mac, ctrlKey: !mac, altKey: true });
    assert.deepEqual(paths, []);
    link.activate({ ...event, metaKey: mac, ctrlKey: !mac });
    assert.deepEqual(paths, ["~user/dir"]);
    assert.equal(link.text, "user@host:~/dir$");
  }
});

test("link ranges follow terminal cells for CJK, emoji, and combining characters", () => {
  const prompt = "user@host:/中文/📁/e\u0301$";
  const [link] = linksFor(fakeTerminal(prompt));
  assert.equal(link.text, prompt);
  assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 21, y: 1 } });
});

test("wrapped prompts remain clickable on every prompt row, excluding the command", () => {
  const terminal = fakeTerminal("user@host:/long/directory$ echo long command", 16);
  const [first] = linksFor(terminal);
  const [second] = linksFor(terminal, undefined, true, 2);
  assert.deepEqual(first.range, second.range);
  assert.deepEqual(first.range, { start: { x: 1, y: 1 }, end: { x: 10, y: 2 } });
  assert.equal(linksFor(terminal, undefined, true, 3), undefined);
});

test("a wide character wrapping from the last column does not add a path space", () => {
  const paths = [];
  const terminal = fakeTerminal("user@host:/中文$ ", 12);
  const [link] = linksFor(terminal, (path) => paths.push(path));
  link.activate({ button: 0, metaKey: true, preventDefault() {} });
  assert.deepEqual(paths, ["/中文"]);
});

test("alternate screens do not expose shell prompt links", () => {
  const terminal = fakeTerminal("user@host:/tmp$ ");
  terminal.buffer.active.type = "alternate";
  assert.equal(linksFor(terminal), undefined);
});
