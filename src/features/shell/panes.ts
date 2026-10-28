/**
 * Split panes. A tab can be split into up to MAX_PANES terminal sessions. Each
 * pane is an ordinary ShellTab; a layout tree arranges them, and the group is
 * known by the id of its first pane, which is the tab shown in the tab bar.
 * Tabs without a layout are single-pane groups.
 */

export type SplitDirection = "row" | "column";

export type PaneNode =
  | { type: "pane"; id: string }
  | {
      type: "split";
      /** "row": children side by side; "column": stacked. */
      direction: SplitDirection;
      children: PaneNode[];
      /** Fractions of this node's width or height, one per child, summing to 1. */
      sizes: number[];
    };

/** Layout trees keyed by group id (the first pane's id). Roots are always splits. */
export type PaneLayouts = Record<string, PaneNode>;

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneDivider {
  /** Child indexes from the root to the split node that owns the divider. */
  path: number[];
  /** The divider sits in front of this child of the split node. */
  index: number;
  direction: SplitDirection;
  /** Position and extent in percent of the terminal area. */
  rect: PaneRect;
  /** Where the two children it separates start, and their combined size, along the split axis (percent). */
  pairStart: number;
  pairSize: number;
}

export const MAX_PANES = 4;
export const MIN_PANE_SIZE = 0.12;

const isMac = /mac/i.test(navigator.platform) || /mac os/i.test(navigator.userAgent);

/** Split shortcuts: ⌘D / ⇧⌘D on macOS (as in iTerm), Ctrl+Shift+D / Ctrl+Shift+E elsewhere. */
export function splitShortcutDirection(event: KeyboardEvent): SplitDirection | null {
  if (event.type !== "keydown" || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (isMac) {
    if (!event.metaKey || event.ctrlKey || key !== "d") return null;
    return event.shiftKey ? "column" : "row";
  }
  if (!event.ctrlKey || !event.shiftKey || event.metaKey) return null;
  return key === "d" ? "row" : key === "e" ? "column" : null;
}

export const splitShortcutLabel: Record<SplitDirection, string> = isMac
  ? { row: "⌘D", column: "⇧⌘D" }
  : { row: "Ctrl+Shift+D", column: "Ctrl+Shift+E" };

/** Pane ids of a tree in display order (left to right, top to bottom). */
export function leafIds(node: PaneNode): string[] {
  return node.type === "pane" ? [node.id] : node.children.flatMap(leafIds);
}

/** The group a tab belongs to: its layout's key, or the tab itself. */
export function groupIdOf(layouts: PaneLayouts, tabId: string) {
  for (const [groupId, root] of Object.entries(layouts)) {
    if (leafIds(root).includes(tabId)) return groupId;
  }
  return tabId;
}

export function paneIdsOf(layouts: PaneLayouts, groupId: string) {
  const root = layouts[groupId];
  return root ? leafIds(root) : [groupId];
}

/** Ids of panes that are not the first pane of their group (hidden from the tab bar). */
export function secondaryPaneIds(layouts: PaneLayouts) {
  const ids = new Set<string>();
  for (const root of Object.values(layouts)) {
    leafIds(root).slice(1).forEach((id) => ids.add(id));
  }
  return ids;
}

/** Split `targetId` in two, putting `newId` after it in `direction`. */
function splitLeaf(node: PaneNode, targetId: string, newId: string, direction: SplitDirection): PaneNode {
  if (node.type === "pane") {
    if (node.id !== targetId) return node;
    return {
      type: "split",
      direction,
      children: [node, { type: "pane", id: newId }],
      sizes: [0.5, 0.5],
    };
  }
  const index = node.children.findIndex((child) => child.type === "pane" && child.id === targetId);
  if (index >= 0 && node.direction === direction) {
    // Same direction as the parent: share the target's space instead of nesting.
    const children = [...node.children];
    children.splice(index + 1, 0, { type: "pane", id: newId });
    const sizes = [...node.sizes];
    const half = sizes[index] / 2;
    sizes.splice(index, 1, half, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((child) => splitLeaf(child, targetId, newId, direction)) };
}

/** Add `newPaneId` next to `targetPaneId` (a pane of `groupId`). */
export function addPane(
  layouts: PaneLayouts,
  groupId: string,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
): PaneLayouts {
  if (paneIdsOf(layouts, groupId).length >= MAX_PANES) return layouts;
  const root: PaneNode = layouts[groupId] ?? { type: "pane", id: groupId };
  return { ...layouts, [groupId]: splitLeaf(root, targetPaneId, newPaneId, direction) };
}

/** Remove panes from a tree, collapsing splits left with a single child. */
function pruneNode(node: PaneNode, removed: Set<string>): PaneNode | null {
  if (node.type === "pane") return removed.has(node.id) ? null : node;
  const kept: Array<{ child: PaneNode; size: number }> = [];
  node.children.forEach((child, index) => {
    const pruned = pruneNode(child, removed);
    if (pruned) kept.push({ child: pruned, size: node.sizes[index] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((sum, item) => sum + item.size, 0) || 1;
  // Merge a child split that runs in the same direction into this one.
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  for (const { child, size } of kept) {
    if (child.type === "split" && child.direction === node.direction) {
      child.children.forEach((grandchild, index) => {
        children.push(grandchild);
        sizes.push((size / total) * child.sizes[index]);
      });
    } else {
      children.push(child);
      sizes.push(size / total);
    }
  }
  return { ...node, children, sizes };
}

/**
 * Remove panes from every group. When a group's first pane goes, the next
 * pane becomes the group id; `renamed` maps old group ids to new ones.
 */
export function removePanes(layouts: PaneLayouts, removed: Set<string>) {
  const next: PaneLayouts = {};
  const renamed = new Map<string, string>();
  for (const [groupId, root] of Object.entries(layouts)) {
    const pruned = pruneNode(root, removed);
    if (!pruned) continue;
    const nextGroupId = leafIds(pruned)[0];
    if (nextGroupId !== groupId) renamed.set(groupId, nextGroupId);
    if (pruned.type === "split") next[nextGroupId] = pruned;
  }
  return { layouts: next, renamed };
}

function nodeAt(root: PaneNode, path: number[]): PaneNode | null {
  let node: PaneNode = root;
  for (const index of path) {
    if (node.type !== "split" || !node.children[index]) return null;
    node = node.children[index];
  }
  return node;
}

function replaceAt(root: PaneNode, path: number[], replacement: PaneNode): PaneNode {
  if (path.length === 0 || root.type !== "split") return replacement;
  const [index, ...rest] = path;
  const children = [...root.children];
  children[index] = replaceAt(children[index], rest, replacement);
  return { ...root, children };
}

/**
 * Move a divider. `fraction` is its new position within the two children it
 * separates (0..1).
 */
export function resizePanes(root: PaneNode, divider: Pick<PaneDivider, "path" | "index">, fraction: number): PaneNode {
  const node = nodeAt(root, divider.path);
  if (!node || node.type !== "split") return root;
  const before = divider.index - 1;
  const pairTotal = node.sizes[before] + node.sizes[divider.index];
  const minFraction = Math.min(0.5, MIN_PANE_SIZE / pairTotal);
  const clamped = Math.min(1 - minFraction, Math.max(minFraction, fraction));
  const sizes = [...node.sizes];
  sizes[before] = pairTotal * clamped;
  sizes[divider.index] = pairTotal * (1 - clamped);
  return replaceAt(root, divider.path, { ...node, sizes });
}

/** Pane rectangles and dividers, in percent of the terminal area. */
export function layoutGeometry(root: PaneNode) {
  const panes: Record<string, PaneRect> = {};
  const dividers: PaneDivider[] = [];
  const walk = (node: PaneNode, rect: PaneRect, path: number[]) => {
    if (node.type === "pane") {
      panes[node.id] = rect;
      return;
    }
    const horizontal = node.direction === "row";
    const start = horizontal ? rect.left : rect.top;
    const extents = node.sizes.map((size) => (horizontal ? rect.width : rect.height) * size);
    const offsets = extents.map((_, index) => start + extents.slice(0, index).reduce((sum, value) => sum + value, 0));
    node.children.forEach((child, index) => {
      const offset = offsets[index];
      const extent = extents[index];
      const childRect = horizontal
        ? { left: offset, top: rect.top, width: extent, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: extent };
      if (index > 0) {
        dividers.push({
          path,
          index,
          direction: node.direction,
          rect: horizontal
            ? { left: offset, top: rect.top, width: 0, height: rect.height }
            : { left: rect.left, top: offset, width: rect.width, height: 0 },
          pairStart: offsets[index - 1],
          pairSize: extents[index - 1] + extent,
        });
      }
      walk(child, childRect, [...path, index]);
    });
  };
  walk(root, { left: 0, top: 0, width: 100, height: 100 }, []);
  return { panes, dividers };
}

/**
 * The pane to activate after `closed` panes go away: the current pane if it
 * survived, else a neighbouring pane of the same group, else the tab next to
 * the closed group in the tab bar.
 */
export function nextActivePane(
  current: string | null,
  closed: Set<string>,
  before: PaneLayouts,
  after: PaneLayouts,
  tabsBefore: Array<{ id: string }>,
  tabsAfter: Array<{ id: string }>,
) {
  if (current && !closed.has(current)) return current;
  if (tabsAfter.length === 0) return null;
  if (current) {
    const siblings = paneIdsOf(before, groupIdOf(before, current));
    const index = siblings.indexOf(current);
    const survivor = [...siblings.slice(0, index).reverse(), ...siblings.slice(index + 1)]
      .find((id) => !closed.has(id));
    if (survivor) return survivor;
  }
  const hiddenBefore = secondaryPaneIds(before);
  const hiddenAfter = secondaryPaneIds(after);
  const barBefore = tabsBefore.filter((tab) => !hiddenBefore.has(tab.id));
  const barAfter = tabsAfter.filter((tab) => !hiddenAfter.has(tab.id));
  const closedIndex = current ? barBefore.findIndex((tab) => tab.id === groupIdOf(before, current)) : 0;
  return barAfter[Math.min(Math.max(0, closedIndex), barAfter.length - 1)]?.id ?? null;
}
