import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
