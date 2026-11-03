import assert from "node:assert/strict";
import test from "node:test";
import { manageNativeDragGhost } from "../src/features/shell/nativeDragGhost.ts";

function fakeWindow(overrides = {}) {
  const calls = [];
  let onCreated;
  return {
    calls,
    create: () => onCreated(),
    windowRef: {
      once: async (event, handler) => {
        assert.equal(event, "tauri://created");
        onCreated = handler;
        return () => {};
      },
      setIgnoreCursorEvents: async (ignore) => calls.push(["ignore", ignore]),
      setShadow: async (shadow) => calls.push(["shadow", shadow]),
      show: async () => calls.push(["show"]),
      destroy: async () => calls.push(["destroy"]),
      ...overrides,
    },
  };
}

test("release before native creation destroys the late window without showing it", async () => {
  const ghost = fakeWindow();
  const stop = manageNativeDragGhost(ghost.windowRef, () => true);
  stop();
  assert.deepEqual(ghost.calls, []);
  await ghost.create();
  assert.deepEqual(ghost.calls, [["destroy"]]);
});

test("active preview becomes click-through before showing and is destroyed once", async () => {
  const ghost = fakeWindow();
  const stop = manageNativeDragGhost(ghost.windowRef, () => true);
  await ghost.create();
  assert.deepEqual(ghost.calls, [["ignore", true], ["shadow", false], ["show"]]);
  stop();
  stop();
  assert.deepEqual(ghost.calls.at(-1), ["destroy"]);
  assert.equal(ghost.calls.filter(([name]) => name === "destroy").length, 1);
});

test("an obsolete drag cannot show a window after a new drag starts", async () => {
  const ghost = fakeWindow();
  let active = true;
  manageNativeDragGhost(ghost.windowRef, () => active);
  active = false;
  await ghost.create();
  assert.deepEqual(ghost.calls, [["destroy"]]);
});

test("release during async setup prevents a later show", async () => {
  let finishSetup;
  const ghost = fakeWindow({
    setIgnoreCursorEvents: () => new Promise((resolve) => { finishSetup = resolve; }),
  });
  const stop = manageNativeDragGhost(ghost.windowRef, () => true);
  const creation = ghost.create();
  stop();
  finishSetup();
  await creation;
  assert.equal(ghost.calls.some(([name]) => name === "show"), false);
  assert.equal(ghost.calls.filter(([name]) => name === "destroy").length, 1);
});

test("release while show is in flight still destroys the preview", async () => {
  let finishShow;
  const ghost = fakeWindow({
    show: () => new Promise((resolve) => { finishShow = resolve; }),
  });
  const stop = manageNativeDragGhost(ghost.windowRef, () => true);
  const creation = ghost.create();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finishShow);
  stop();
  finishShow();
  await creation;
  assert.equal(ghost.calls.filter(([name]) => name === "destroy").length, 1);
});
