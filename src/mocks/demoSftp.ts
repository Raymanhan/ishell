import type { DownloadItem, SftpEntry } from "../types";
import { demoFiles } from "./demoData";

export function loadDemoFiles(path: string) {
  return new Promise<SftpEntry[]>((resolve) => {
    setTimeout(() => {
      const suffix = path === "/" ? "" : path;
      resolve(
        demoFiles.map((entry, index) => ({
          ...entry,
          path: entry.path.startsWith("/") ? `${suffix}${entry.path}`.replace("//", "/") : entry.path,
          name: index > 2 && path !== "/" ? `${entry.name.replace(".", `-${path.split("/").pop()}.`)}` : entry.name,
        })),
      );
    }, 220);
  });
}

export function simulateDemoDownload(
  item: DownloadItem,
  onProgress?: (transferred: number, total: number) => void,
) {
  return new Promise<string>((resolve) => {
    const total = item.total || 1_000_000;
    let transferred = 0;
    const step = Math.max(1, Math.ceil(total / 20));
    const timer = window.setInterval(() => {
      transferred = Math.min(total, transferred + step);
      onProgress?.(transferred, total);
      if (transferred >= total) {
        window.clearInterval(timer);
        resolve(`~/Downloads/${item.name}`);
      }
    }, 120);
  });
}
