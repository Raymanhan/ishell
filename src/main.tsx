import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";
import { readTailViewerConfigFromUrl, TailViewer } from "./components/TailViewer";

const platformSource = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
const platform =
  platformSource.includes("win")
    ? "windows"
    : platformSource.includes("mac")
      ? "macos"
      : platformSource.includes("linux")
        ? "linux"
        : "other";

document.documentElement.dataset.platform = platform;
const tailViewerConfig = readTailViewerConfigFromUrl();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {tailViewerConfig ? <TailViewer config={tailViewerConfig} /> : <App />}
  </React.StrictMode>,
);
