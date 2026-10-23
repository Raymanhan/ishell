#!/usr/bin/env node
// Builds latest.json, the manifest the in-app updater (tauri-plugin-updater)
// polls, from the signed update packages produced by the release workflow.
//
// Usage:
//   node scripts/build-updater-manifest.mjs --dir artifacts --tag v1.2.3 \
//     --repo Raymanhan/ishell --out latest.json [--changelog README.zh-CN.md]
//
// With --changelog, the release notes shown in the update prompt are taken
// from that file's "- `v1.2.3` ..." entry.
//
// Every package must sit next to its detached signature (<file>.sig). Packages
// are matched by the names the workflow gives them, so the manifest does not
// depend on how the artifacts are laid out on disk.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const PLATFORMS = [
  { key: "darwin-aarch64", pattern: /_aarch64\.app\.tar\.gz$/ },
  { key: "darwin-x86_64", pattern: /_x64\.app\.tar\.gz$/ },
  { key: "windows-x86_64", pattern: /_x64-setup\.exe$/ },
  { key: "linux-x86_64", pattern: /_amd64\.AppImage$/ },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Unexpected argument: ${key ?? ""}`);
    }
    args[key.slice(2)] = value;
  }
  for (const required of ["dir", "tag", "repo", "out"]) {
    if (!args[required]) throw new Error(`Missing --${required}`);
  }
  return args;
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const args = parseArgs(process.argv.slice(2));
const files = listFiles(args.dir);
const signatures = new Map(
  files.filter((path) => path.endsWith(".sig")).map((path) => [path.slice(0, -".sig".length), path]),
);

const platforms = {};
for (const { key, pattern } of PLATFORMS) {
  const matches = files.filter((path) => pattern.test(basename(path)) && signatures.has(path));
  if (matches.length > 1) {
    throw new Error(`Several signed packages match ${key}: ${matches.map((path) => basename(path)).join(", ")}`);
  }
  const [file] = matches;
  if (!file) {
    console.warn(`warning: no signed update package for ${key}`);
    continue;
  }
  platforms[key] = {
    signature: readFileSync(signatures.get(file), "utf8").trim(),
    url: `https://github.com/${args.repo}/releases/download/${args.tag}/${encodeURIComponent(basename(file))}`,
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error("No signed update packages found; refusing to publish an empty manifest.");
}

function changelogEntry(path, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readFileSync(path, "utf8").match(new RegExp(`^- \`${escaped}\` (.+)$`, "m"));
  return match?.[1].trim();
}

const manifest = {
  version: args.tag.replace(/^v/, ""),
  notes: (args.changelog && changelogEntry(args.changelog, args.tag)) || `iShell ${args.tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${args.out} for ${Object.keys(platforms).join(", ")}`);
