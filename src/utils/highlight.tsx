import type { ReactNode } from "react";

export interface HighlightToken {
  text: string;
  kind?: string;
}

export function textOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  highlight: HTMLPreElement,
  x: number,
  y: number,
) {
  const textareaPointerEvents = textarea.style.pointerEvents;
  const highlightPointerEvents = highlight.style.pointerEvents;
  const highlightZIndex = highlight.style.zIndex;
  textarea.style.pointerEvents = "none";
  highlight.style.pointerEvents = "auto";
  highlight.style.zIndex = "2";

  let node: Node | null = null;
  let nodeOffset = 0;
  try {
    const documentWithCaretRange = document as Document & {
      caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
    };
    const caretPosition = document.caretPositionFromPoint?.(x, y);
    const caretRange = caretPosition ? null : documentWithCaretRange.caretRangeFromPoint?.(x, y);
    node = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
    nodeOffset = caretPosition?.offset ?? caretRange?.startOffset ?? 0;
  } finally {
    textarea.style.pointerEvents = textareaPointerEvents;
    highlight.style.pointerEvents = highlightPointerEvents;
    highlight.style.zIndex = highlightZIndex;
  }

  if (!node || !highlight.contains(node)) return null;
  try {
    const range = document.createRange();
    range.setStart(highlight, 0);
    range.setEnd(node, nodeOffset);
    return Math.min(textarea.value.length, range.toString().length);
  } catch {
    return null;
  }
}

export const HIGHLIGHT_MAX_BYTES = 220_000;
export const CODE_KEYWORDS = new Set([
  "abstract", "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "defer", "delete", "do", "else", "enum", "export", "extends", "false", "final",
  "finally", "for", "from", "func", "function", "go", "if", "implements", "import", "in", "interface",
  "let", "match", "mod", "new", "nil", "null", "or", "package", "private", "protected", "public",
  "return", "self", "static", "struct", "super", "switch", "this", "throw", "throws", "trait", "true",
  "try", "type", "undefined", "use", "var", "void", "while", "yield",
]);
export const SQL_KEYWORDS = new Set([
  "alter", "and", "as", "between", "by", "case", "create", "delete", "desc", "distinct", "drop",
  "else", "end", "exists", "from", "group", "having", "in", "inner", "insert", "into", "is", "join",
  "left", "like", "limit", "not", "null", "on", "or", "order", "outer", "right", "select", "set",
  "table", "then", "union", "update", "values", "when", "where",
]);

export function renderHighlightedCode(fileName: string, content: string): ReactNode {
  if (!content) return " ";
  // A <textarea> renders a phantom empty line for a trailing newline while a <pre>
  // swallows it, making this highlight overlay one line shorter than the textarea.
  // That height mismatch clamps the synced scrollTop and shifts the highlighted text
  // one line away from the textarea's selection. Append a trailing <br> to keep the
  // two scroll heights in sync so selections line up with the code they cover.
  const eol = <br key="__eol" />;
  if (new TextEncoder().encode(content).length > HIGHLIGHT_MAX_BYTES) return [content, eol];
  const language = languageForFile(fileName);
  const tokens = tokenizeForLanguage(content, language);
  return [
    ...tokens.map((token, index) =>
      token.kind
        ? <span key={index} className={`syntax-${token.kind}`}>{token.text}</span>
        : token.text,
    ),
    eol,
  ];
}

export function languageForFile(fileName: string) {
  const name = fileName.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (["json"].includes(extension)) return "json";
  if (["ts", "tsx", "js", "jsx", "mjs", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "kt", "php", "rb", "py", "lua"].includes(extension)) return "code";
  if (["css", "scss", "less"].includes(extension)) return "css";
  if (["html", "htm", "xml", "svg"].includes(extension)) return "markup";
  if (["md", "markdown"].includes(extension) || name === "readme") return "markdown";
  if (["sh", "bash", "zsh"].includes(extension) || name.startsWith(".bash") || name.startsWith(".zsh")) return "shell";
  if (["sql"].includes(extension)) return "sql";
  if (["yaml", "yml", "toml", "ini", "env", "properties"].includes(extension) || name === ".env") return "config";
  return "plain";
}

export function tokenizeForLanguage(content: string, language: string) {
  switch (language) {
    case "json":
      return tokenizeByPattern(content, /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b|[{}\[\]:,]/gi, classifyJsonToken);
    case "css":
      return tokenizeByPattern(content, /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-fA-F]{3,8}\b|--?[A-Za-z_][\w-]*(?=\s*:)|@[A-Za-z-]+|\b(?:from|to|important)\b|[{}():;,]/g, classifyCssToken);
    case "markup":
      return tokenizeByPattern(content, /<!--[\s\S]*?-->|<\/?[A-Za-z][^>\s/]*|\/?>|[A-Za-z_:][-A-Za-z0-9_:.]*(?==)|"(?:&quot;|[^"])*"|'[^']*'|&[A-Za-z0-9#]+;/g, classifyMarkupToken);
    case "markdown":
      return tokenizeByPattern(content, /```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]+\)|^#{1,6} [^\n]*(?:\n|$)/gm, classifyMarkdownToken);
    case "shell":
    case "code":
      return tokenizeByPattern(content, /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*|#[^\n\r]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b|[{}()[\];,.]/g, classifyCodeToken);
    case "sql":
      return tokenizeByPattern(content, /--[^\n\r]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b|[(),.;=*<>+-]/g, classifySqlToken);
    case "config":
      return tokenizeByPattern(content, /#[^\n\r]*|;[^\n\r]*|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|^[ \t-]*[A-Za-z0-9_.-]+(?=\s*[:=])|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b|[:=[\]{},-]/gim, classifyConfigToken);
    default:
      return [{ text: content }];
  }
}

export function tokenizeByPattern(content: string, pattern: RegExp, classify: (token: string) => string | undefined) {
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const text = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: content.slice(cursor, index) });
    tokens.push({ text, kind: classify(text) });
    cursor = index + text.length;
  }
  if (cursor < content.length) tokens.push({ text: content.slice(cursor) });
  return tokens;
}

export function classifyJsonToken(token: string) {
  if (token.startsWith("\"")) return token.match(/"\s*$/) ? "string" : "key";
  if (/^-?\d/.test(token)) return "number";
  if (/^(true|false|null)$/i.test(token)) return "literal";
  return "punct";
}

export function classifyCodeToken(token: string) {
  if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#")) return "comment";
  if (/^["'`]/.test(token)) return "string";
  if (/^\d/.test(token)) return "number";
  if (CODE_KEYWORDS.has(token)) return token === "true" || token === "false" || token === "null" || token === "undefined" || token === "nil" ? "literal" : "keyword";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return "type";
  if (/^[{}()[\];,.]$/.test(token)) return "punct";
  return undefined;
}

export function classifyCssToken(token: string) {
  if (token.startsWith("/*")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (token.startsWith("#")) return "number";
  if (token.startsWith("@") || token === "important") return "keyword";
  if (/^-?-?[A-Za-z_]/.test(token)) return "key";
  return "punct";
}

export function classifyMarkupToken(token: string) {
  if (token.startsWith("<!--")) return "comment";
  if (token.startsWith("<")) return "keyword";
  if (/^["']/.test(token)) return "string";
  if (token.startsWith("&")) return "literal";
  if (token === ">" || token === "/>") return "punct";
  return "key";
}

export function classifyMarkdownToken(token: string) {
  if (token.startsWith("#")) return "keyword";
  if (token.startsWith("```") || token.startsWith("`")) return "string";
  if (token.startsWith("[")) return "literal";
  return "type";
}

export function classifySqlToken(token: string) {
  if (token.startsWith("--") || token.startsWith("/*")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (/^\d/.test(token)) return "number";
  if (SQL_KEYWORDS.has(token.toLowerCase())) return "keyword";
  return /^[(),.;=*<>+-]$/.test(token) ? "punct" : undefined;
}

export function classifyConfigToken(token: string) {
  if (token.startsWith("#") || token.startsWith(";")) return "comment";
  if (/^["']/.test(token)) return "string";
  if (/^\d|^-?\d/.test(token)) return "number";
  if (/^(true|false|null|yes|no|on|off)$/i.test(token)) return "literal";
  if (/^[ \t-]*[A-Za-z0-9_.-]+$/.test(token)) return "key";
  return "punct";
}
