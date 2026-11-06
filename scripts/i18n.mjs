#!/usr/bin/env node
// Translation catalog tool.
//
//   node scripts/i18n.mjs check              list missing / unused catalog keys (exit 1 if missing)
//   node scripts/i18n.mjs keys               print every source message as JSON
//   node scripts/i18n.mjs merge <locale> <file.json>
//                                            merge {source: translation} into a catalog
//
// Message ids are the Simplified Chinese source text:
// - UI text: the first argument of t("…") / msg("…") in src/**/*.ts(x);
// - backend text: Chinese string literals in src-tauri/src (Rust and the remote
//   Python runner). `format!` placeholders become {0}, {1} …, so filled-in
//   messages can be matched and translated by translateMessage().
// Traditional Chinese is regenerated from the source text with OpenCC
// (s2twp): pip install opencc-python-reimplemented, then `node scripts/i18n.mjs zh-tw`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAN = /[㐀-鿿]/;
export const LOCALES = ["en", "zh-TW"];

function gitFiles(dir, pattern) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", dir], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => pattern.test(file) && fs.existsSync(path.join(repo, file)));
}

/** Source text passed to t() / msg() / translateIn(locale, …). */
export function frontendKeys() {
  const ts = createRequire(path.join(repo, "package.json"))("typescript");
  const keys = new Map();
  for (const file of gitFiles("src", /\.(ts|tsx)$/)) {
    if (file.startsWith("src/i18n/")) continue;
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const arg = name === "translateIn" ? node.arguments[1] : node.arguments[0];
        if ((name === "t" || name === "msg" || name === "translateIn") && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const line = source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1;
          if (!keys.has(arg.text)) keys.set(arg.text, `${file}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return keys;
}

// Text that only the model reads (system prompts, tool schemas, compaction
// prompts) is never shown to users and stays in Chinese.
const MODEL_FACING = ["你只负责压缩", "历史片段", "[已自动压缩", "{system}", "当前权限模式"];
// Messages assembled by string concatenation in the remote runner.
const EXTRA_BACKEND = ["已写入 {0}"];
// Hand-reviewed Traditional Chinese that should override the OpenCC output.
const REVIEWED_ZH_TW = {};

function rustLiterals(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 2;
      if (i < 2) break;
    } else if (c === "r" && /^r#*"/.test(text.slice(i, i + 10)) && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) {
      const hashes = text.slice(i + 1).match(/^#*/)[0];
      const end = text.indexOf(`"${hashes}`, i + 2 + hashes.length);
      i = end < 0 ? text.length : end + 1 + hashes.length; // raw strings: model prompts
    } else if (c === "'") {
      if (text[i + 1] === "\\") i = text.indexOf("'", i + 3) + 1;
      else if (text[i + 2] === "'") i += 3;
      else i += 1; // lifetime
    } else if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          const next = text[j + 1];
          if (next === "\n") {
            j += 2;
            while (/\s/.test(text[j])) j++;
            continue;
          }
          value += { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "'": "'" }[next] ?? next;
          j += 2;
        } else value += text[j++];
      }
      out.push(value);
      i = j + 1;
    } else i++;
  }
  return out;
}

function rustTemplate(value) {
  let index = 0;
  return value
    .replace(/\{\{|\}\}|\{[^{}]*\}/g, (part) => (part === "{{" ? "{" : part === "}}" ? "}" : `{${index++}}`));
}

/** Chinese messages the backend can return to the UI. */
export function backendKeys() {
  const keys = new Map();
  for (const file of gitFiles("src-tauri/src", /\.rs$/)) {
    let text = fs.readFileSync(path.join(repo, file), "utf8");
    const testStart = text.indexOf("#[cfg(test)]");
    if (testStart >= 0) text = text.slice(0, testStart);
    const definitions = text.indexOf("pub fn definitions()");
    if (definitions >= 0) {
      const end = text.indexOf("\n}\n", definitions);
      text = text.slice(0, definitions) + text.slice(end);
    }
    for (const literal of rustLiterals(text)) {
      if (!HAN.test(literal) || MODEL_FACING.some((prefix) => literal.startsWith(prefix))) continue;
      const key = rustTemplate(literal);
      // A template must keep some Chinese outside its placeholders.
      if (HAN.test(key.replace(/\{\d+\}/g, "")) && !keys.has(key)) keys.set(key, file);
    }
  }
  for (const file of gitFiles("src-tauri/src", /\.py$/)) {
    const text = fs.readFileSync(path.join(repo, file), "utf8").replace(/^\s*#.*$/gm, "");
    for (const match of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const literal = (match[1] ?? match[2]).trim();
      if (HAN.test(literal) && !keys.has(literal)) keys.set(literal, file);
    }
  }
  for (const key of EXTRA_BACKEND) keys.set(key, "runner");
  return keys;
}

export function allKeys() {
  const keys = new Map(backendKeys());
  for (const [key, where] of frontendKeys()) keys.set(key, where);
  return keys;
}

const catalogPath = (locale) => path.join(repo, "src/i18n/locales", `${locale}.ts`);

export async function readCatalog(locale) {
  const text = fs.readFileSync(catalogPath(locale), "utf8");
  const body = text.slice(text.indexOf("= {") + 2, text.lastIndexOf("}") + 1);
  return JSON.parse(body.replace(/,\s*}$/, "}"));
}

export function writeCatalog(locale, catalog) {
  const keys = allKeys();
  const entries = Object.keys(catalog)
    .filter((key) => keys.has(key) && catalog[key] !== "")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(catalog[key])},`);
  const header = `// ${locale} catalog. Keys are the Simplified Chinese source text; maintained with scripts/i18n.mjs.\n`;
  fs.writeFileSync(catalogPath(locale), `${header}const catalog: Record<string, string> = {\n${entries.join("\n")}\n};\nexport default catalog;\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keys") {
    console.log(JSON.stringify(Object.fromEntries(allKeys()), null, 2));
  } else if (command === "check") {
    const keys = allKeys();
    let missing = 0;
    for (const locale of LOCALES) {
      const catalog = await readCatalog(locale);
      const absent = [...keys.keys()].filter((key) => !(key in catalog));
      const unused = Object.keys(catalog).filter((key) => !keys.has(key));
      missing += absent.length;
      console.log(`${locale}: ${keys.size - absent.length}/${keys.size} translated, ${unused.length} unused`);
      for (const key of absent) console.log(`  missing  ${JSON.stringify(key)}  (${keys.get(key)})`);
      for (const key of unused) console.log(`  unused   ${JSON.stringify(key)}`);
    }
    process.exitCode = missing ? 1 : 0;
  } else if (command === "merge") {
    const [locale, file] = args;
    const catalog = { ...(await readCatalog(locale)), ...JSON.parse(fs.readFileSync(file, "utf8")) };
    writeCatalog(locale, catalog);
  } else if (command === "zh-tw") {
    const keys = [...allKeys().keys()];
    const converted = JSON.parse(
      execFileSync("python3", ["-c", "import json,sys\nfrom opencc import OpenCC\nc=OpenCC('s2twp')\nprint(json.dumps({k:c.convert(k) for k in json.load(sys.stdin)},ensure_ascii=False))"], {
        input: JSON.stringify(keys),
        encoding: "utf8",
      }),
    );
    // Taiwan usage that s2twp leaves in mainland wording (all "地址" here are network addresses).
    const tw = (text) => text.replaceAll("新建", "新增").replaceAll("響應", "回應").replaceAll("地址", "位址");
    for (const key of Object.keys(converted)) converted[key] = tw(converted[key]);
    // Fresh conversions win unless a reviewed translation is pinned in REVIEWED_ZH_TW.
    writeCatalog("zh-TW", { ...converted, ...REVIEWED_ZH_TW });
  } else {
    console.log("usage: node scripts/i18n.mjs check | keys | merge <locale> <file.json> | zh-tw");
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
