const UI_WIDTH = 292;
const MIN_UI_HEIGHT = 220;
const MAX_UI_HEIGHT = 900;
const EPSILON = 0.01;
const ROTATION_EPSILON = 1e-4;

figma.showUI(__html__, { width: UI_WIDTH, height: 296 });

const VALID_MODES = new Set([
  "all",
  "vertical",
  "horizontal",
  "top",
  "right",
  "bottom",
  "left"
]);

const SETTING_DEFS = {
  mode: {
    key: "resize-to-content.mode",
    defaultValue: "all",
    sanitize: sanitizeMode,
    uiType: "set-mode"
  },
  padding: {
    key: "resize-to-content.padding",
    defaultValue: 0,
    sanitize: sanitizeNonNegativeNumber,
    uiType: "set-padding"
  },
  gap: {
    key: "resize-to-content.gap",
    defaultValue: 0,
    sanitize: sanitizeNonNegativeNumber,
    uiType: "set-gap"
  },
  removeLastGap: {
    key: "resize-to-content.remove-last-gap",
    defaultValue: false,
    sanitize: sanitizeBoolean,
    uiType: "set-remove-last-gap"
  }
};

const SAVE_MESSAGE_TO_SETTING = {
  "save-mode": "mode",
  "save-padding": "padding",
  "save-gap": "gap",
  "save-remove-last-gap": "removeLastGap"
};

const settings = {
  mode: SETTING_DEFS.mode.defaultValue,
  padding: SETTING_DEFS.padding.defaultValue,
  gap: SETTING_DEFS.gap.defaultValue,
  removeLastGap: SETTING_DEFS.removeLastGap.defaultValue
};

const RELAUNCH_KEY = "open";
const RELAUNCH_LABEL = "";

let isUiReady = false;
let lastPostedFrameCount = -1;
const dirtySettings = new Set();
const settingWriteChains = {};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeNonNegativeNumber(value) {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

function sanitizeBoolean(value) {
  return value === true;
}

function sanitizeMode(value) {
  return typeof value === "string" && VALID_MODES.has(value) ? value : "all";
}

function resizeUi(height) {
  const safeHeight = clamp(Math.round(height), MIN_UI_HEIGHT, MAX_UI_HEIGHT);
  try {
    figma.ui.resize(UI_WIDTH, safeHeight);
  } catch (_error) {
    // Ignore invalid resize attempts.
  }
}

function isFrameNode(node) {
  return node.type === "FRAME";
}

function isAutoLayoutFrame(frame) {
  return frame.layoutMode === "HORIZONTAL" || frame.layoutMode === "VERTICAL";
}

function isAutoLayoutFlowChild(child, frame) {
  return isAutoLayoutFrame(frame) && child.layoutPositioning !== "ABSOLUTE";
}

function isInsideInstance(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "INSTANCE") return true;
    parent = parent.parent;
  }
  return false;
}

function getNodeDepth(node) {
  let depth = 0;
  let parent = node.parent;
  while (parent) {
    depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function isBottomConstrainedNode(node) {
  if (!node.visible) return false;

  if (node.type === "GROUP" && Array.isArray(node.children)) {
    let hasVisibleChild = false;
    for (const descendant of node.children) {
      if (!descendant.visible) continue;
      hasVisibleChild = true;
      if (!isBottomConstrainedNode(descendant)) return false;
    }
    return hasVisibleChild;
  }

  if (!("constraints" in node) || !node.constraints) return false;
  const vertical = node.constraints.vertical;
  return vertical === "MAX" || vertical === "BOTTOM";
}

function isBottomConstrained(child, frame) {
  if (isAutoLayoutFlowChild(child, frame)) return false;
  return isBottomConstrainedNode(child);
}

function countSelectedFrames() {
  let count = 0;
  for (const node of figma.currentPage.selection) {
    if (isFrameNode(node)) count += 1;
  }
  return count;
}

function updateSelectionInfo(force = false) {
  if (!isUiReady) return;
  const frameCount = countSelectedFrames();
  if (!force && frameCount === lastPostedFrameCount) return;
  lastPostedFrameCount = frameCount;
  figma.ui.postMessage({
    type: "selection-info",
    frameCount
  });
}

function getChildBoundsInFrame(child, frame) {
  if (!child.visible) return null;

  if (
    "width" in child &&
    "height" in child &&
    "relativeTransform" in child &&
    Array.isArray(child.relativeTransform)
  ) {
    const w = child.width;
    const h = child.height;
    if (Number.isFinite(w) && Number.isFinite(h)) {
      const t = child.relativeTransform;
      const a = t[0][0];
      const b = t[0][1];
      const tx = t[0][2];
      const c = t[1][0];
      const d = t[1][1];
      const ty = t[1][2];

      if (a === 1 && b === 0 && c === 0 && d === 1) {
        return {
          minX: tx,
          minY: ty,
          maxX: tx + w,
          maxY: ty + h
        };
      }

      const x0 = tx;
      const y0 = ty;
      const x1 = a * w + tx;
      const y1 = c * w + ty;
      const x2 = b * h + tx;
      const y2 = d * h + ty;
      const x3 = a * w + b * h + tx;
      const y3 = c * w + d * h + ty;

      return {
        minX: Math.min(x0, x1, x2, x3),
        minY: Math.min(y0, y1, y2, y3),
        maxX: Math.max(x0, x1, x2, x3),
        maxY: Math.max(y0, y1, y2, y3)
      };
    }
  }

  if ("x" in child && "y" in child && "width" in child && "height" in child) {
    if (
      Number.isFinite(child.x) &&
      Number.isFinite(child.y) &&
      Number.isFinite(child.width) &&
      Number.isFinite(child.height)
    ) {
      return {
        minX: child.x,
        minY: child.y,
        maxX: child.x + child.width,
        maxY: child.y + child.height
      };
    }
  }

  if (
    "absoluteRenderBounds" in child &&
    child.absoluteRenderBounds &&
    Array.isArray(frame.absoluteTransform)
  ) {
    const abs = child.absoluteRenderBounds;
    const t = frame.absoluteTransform;
    const a = t[0][0];
    const b = t[0][1];
    const tx = t[0][2];
    const c = t[1][0];
    const d = t[1][1];
    const ty = t[1][2];
    const det = a * d - b * c;

    if (Math.abs(det) > 1e-8) {
      const corners = [
        [abs.x, abs.y],
        [abs.x + abs.width, abs.y],
        [abs.x, abs.y + abs.height],
        [abs.x + abs.width, abs.y + abs.height]
      ];
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [gx, gy] of corners) {
        const dx = gx - tx;
        const dy = gy - ty;
        const lx = (d * dx - b * dy) / det;
        const ly = (-c * dx + a * dy) / det;
        minX = Math.min(minX, lx);
        minY = Math.min(minY, ly);
        maxX = Math.max(maxX, lx);
        maxY = Math.max(maxY, ly);
      }
      return { minX, minY, maxX, maxY };
    }

    return {
      minX: abs.x - tx,
      minY: abs.y - ty,
      maxX: abs.x + abs.width - tx,
      maxY: abs.y + abs.height - ty
    };
  }

  return null;
}

function getContentBounds(frame) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let flowMinX = Number.POSITIVE_INFINITY;
  let flowMinY = Number.POSITIVE_INFINITY;
  let flowMaxX = Number.NEGATIVE_INFINITY;
  let flowMaxY = Number.NEGATIVE_INFINITY;
  let hasFlowChildren = false;
  let maxYWithoutBottomConstraint = Number.NEGATIVE_INFINITY;
  let bottomConstrainedGroupMinY = Number.POSITIVE_INFINITY;
  let bottomConstrainedGroupMaxY = Number.NEGATIVE_INFINITY;
  const bottomConstrainedChildren = [];
  let found = false;

  for (const child of frame.children) {
    const bounds = getChildBoundsInFrame(child, frame);
    if (!bounds) continue;

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);

    if (isAutoLayoutFlowChild(child, frame)) {
      flowMinX = Math.min(flowMinX, bounds.minX);
      flowMinY = Math.min(flowMinY, bounds.minY);
      flowMaxX = Math.max(flowMaxX, bounds.maxX);
      flowMaxY = Math.max(flowMaxY, bounds.maxY);
      hasFlowChildren = true;
    }

    if (isBottomConstrained(child, frame) && "y" in child) {
      bottomConstrainedGroupMinY = Math.min(bottomConstrainedGroupMinY, bounds.minY);
      bottomConstrainedGroupMaxY = Math.max(bottomConstrainedGroupMaxY, bounds.maxY);
      bottomConstrainedChildren.push(child);
    } else {
      maxYWithoutBottomConstraint = Math.max(maxYWithoutBottomConstraint, bounds.maxY);
    }
    found = true;
  }

  if (!found) return null;

  const hasBottomConstrainedChildren = bottomConstrainedChildren.length > 0;
  return {
    minX,
    minY,
    maxX,
    maxY,
    flowBounds: hasFlowChildren
      ? { minX: flowMinX, minY: flowMinY, maxX: flowMaxX, maxY: flowMaxY }
      : null,
    maxYWithoutBottomConstraint: Number.isFinite(maxYWithoutBottomConstraint)
      ? maxYWithoutBottomConstraint
      : null,
    bottomConstrainedGroupMinY: hasBottomConstrainedChildren
      ? bottomConstrainedGroupMinY
      : null,
    bottomConstrainedGroupMaxY: hasBottomConstrainedChildren
      ? bottomConstrainedGroupMaxY
      : null,
    bottomConstrainedChildren
  };
}

function shouldTrimLeft(mode) {
  return mode === "all" || mode === "horizontal" || mode === "left";
}

function shouldTrimRight(mode) {
  return mode === "all" || mode === "horizontal" || mode === "right";
}

function shouldTrimTop(mode) {
  return mode === "all" || mode === "vertical" || mode === "top";
}

function shouldTrimBottom(mode) {
  return mode === "all" || mode === "vertical" || mode === "bottom";
}

function captureAndFreezeChildConstraints(frame, nodes = frame.children, frozen = [], checkAutoLayoutFlow = true) {
  for (const child of nodes) {
    if (checkAutoLayoutFlow && isAutoLayoutFlowChild(child, frame)) continue;

    if (child.type === "GROUP" && Array.isArray(child.children)) {
      captureAndFreezeChildConstraints(frame, child.children, frozen, false);
      continue;
    }

    if (!("constraints" in child) || !child.constraints) continue;
    const current = child.constraints;
    if (current.horizontal === "MIN" && current.vertical === "MIN") continue;

    frozen.push({
      child,
      constraints: {
        horizontal: current.horizontal,
        vertical: current.vertical
      }
    });

    try {
      child.constraints = { horizontal: "MIN", vertical: "MIN" };
    } catch (_error) {
      // Ignore children that do not allow constraints to be set.
    }
  }

  return frozen;
}

function restoreChildConstraints(frozen) {
  for (const item of frozen) {
    try {
      item.child.constraints = item.constraints;
    } catch (_error) {
      // Ignore children that do not allow constraints to be restored.
    }
  }
}

function captureChildGeometry(frame) {
  const snapshot = [];

  for (const child of frame.children) {
    if (isAutoLayoutFlowChild(child, frame)) continue;

    try {
      if (!("x" in child) || !("y" in child)) continue;

      const item = {
        child,
        x: child.x,
        y: child.y
      };

      if (
        "width" in child &&
        "height" in child &&
        typeof child.resizeWithoutConstraints === "function"
      ) {
        item.width = child.width;
        item.height = child.height;
      }

      snapshot.push(item);
    } catch (_error) {
      // Ignore children that cannot be captured.
    }
  }

  return snapshot;
}

function restoreChildGeometry(snapshot, shiftX, shiftY) {
  for (const item of snapshot) {
    try {
      const child = item.child;

      if (
        typeof item.width === "number" &&
        typeof item.height === "number" &&
        typeof child.resizeWithoutConstraints === "function"
      ) {
        if (Math.abs(child.width - item.width) > EPSILON || Math.abs(child.height - item.height) > EPSILON) {
          child.resizeWithoutConstraints(item.width, item.height);
        }
      }

      if ("x" in child) {
        const targetX = item.x + shiftX;
        if (Math.abs(child.x - targetX) > EPSILON) child.x = targetX;
      }
      if ("y" in child) {
        const targetY = item.y + shiftY;
        if (Math.abs(child.y - targetY) > EPSILON) child.y = targetY;
      }
    } catch (_error) {
      // Ignore children that cannot be restored.
    }
  }
}

function getPrimaryAxisForGap(frame, entries) {
  if (frame.layoutMode === "HORIZONTAL") return "x";
  if (frame.layoutMode === "VERTICAL") return "y";

  let minStartX = Number.POSITIVE_INFINITY;
  let maxStartX = Number.NEGATIVE_INFINITY;
  let minStartY = Number.POSITIVE_INFINITY;
  let maxStartY = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    minStartX = Math.min(minStartX, entry.bounds.minX);
    maxStartX = Math.max(maxStartX, entry.bounds.minX);
    minStartY = Math.min(minStartY, entry.bounds.minY);
    maxStartY = Math.max(maxStartY, entry.bounds.minY);
  }

  const spreadX = maxStartX - minStartX;
  const spreadY = maxStartY - minStartY;
  return spreadY >= spreadX ? "y" : "x";
}

function getOrderedGapEntries(frame) {
  const entries = [];
  for (const child of frame.children) {
    const bounds = getChildBoundsInFrame(child, frame);
    if (!bounds) continue;
    entries.push({ child, bounds });
  }

  if (entries.length < 2) return null;
  const axis = getPrimaryAxisForGap(frame, entries);

  entries.sort((a, b) => {
    const aStart = axis === "x" ? a.bounds.minX : a.bounds.minY;
    const bStart = axis === "x" ? b.bounds.minX : b.bounds.minY;
    if (aStart !== bStart) return aStart - bStart;

    const aEnd = axis === "x" ? a.bounds.maxX : a.bounds.maxY;
    const bEnd = axis === "x" ? b.bounds.maxX : b.bounds.maxY;
    return aEnd - bEnd;
  });

  return { axis, entries };
}

function countVisibleFlowChildren(frame) {
  let count = 0;
  for (const child of frame.children) {
    if (child.visible && isAutoLayoutFlowChild(child, frame)) {
      count += 1;
      if (count >= 2) return count;
    }
  }
  return count;
}

function setAutoLayoutItemSpacing(frame, targetGap) {
  if (!isAutoLayoutFrame(frame) || typeof frame.itemSpacing !== "number") return false;
  if (frame.primaryAxisAlignItems === "SPACE_BETWEEN") return false;
  if (countVisibleFlowChildren(frame) < 2) return false;
  try {
    if (Math.abs(frame.itemSpacing - targetGap) <= EPSILON) return false;
    frame.itemSpacing = targetGap;
    return true;
  } catch (_spacingError) {
    return false;
  }
}

function collapseGapToImmediatePrevious(frame, targetGap) {
  const ordered = getOrderedGapEntries(frame);
  if (!ordered) return false;

  const { axis, entries } = ordered;
  const lastEntry = entries[entries.length - 1];
  const prevEntry = entries[entries.length - 2];
  const lastChild = lastEntry.child;

  if (isAutoLayoutFlowChild(lastChild, frame)) {
    return setAutoLayoutItemSpacing(frame, targetGap);
  }

  const lastStart = axis === "x" ? lastEntry.bounds.minX : lastEntry.bounds.minY;
  const immediatePrevEnd = axis === "x" ? prevEntry.bounds.maxX : prevEntry.bounds.maxY;
  if (lastStart - immediatePrevEnd < -EPSILON) return false;

  let precedingEnd = immediatePrevEnd;
  for (let i = 0; i < entries.length - 1; i += 1) {
    const end = axis === "x" ? entries[i].bounds.maxX : entries[i].bounds.maxY;
    if (end <= lastStart + EPSILON && end > precedingEnd) {
      precedingEnd = end;
    }
  }

  const gap = Math.max(0, lastStart - precedingEnd);
  const delta = targetGap - gap;
  if (Math.abs(delta) <= EPSILON) return false;

  try {
    if (axis === "x") {
      if (!("x" in lastChild)) return false;
      const before = lastChild.x;
      lastChild.x += delta;
      return Math.abs(lastChild.x - before) > EPSILON;
    }
    if (!("y" in lastChild)) return false;
    const before = lastChild.y;
    lastChild.y += delta;
    return Math.abs(lastChild.y - before) > EPSILON;
  } catch (_error) {
    return false;
  }
}

function applyBounds(frame, mode, contentBounds, padding, bottomConstraintGap = 0) {
  const frozenChildConstraints = captureAndFreezeChildConstraints(frame);
  const preservedGeometry = captureChildGeometry(frame);
  const oldX = frame.x;
  const oldY = frame.y;
  const oldWidth = frame.width;
  const oldHeight = frame.height;
  const standardHeight = contentBounds.maxY - contentBounds.minY + padding * 2;
  const standardBottomHeight = contentBounds.maxY + padding;
  const hasBottomConstrainedChildren = contentBounds.bottomConstrainedChildren.length > 0;
  const hasNonBottomContent = typeof contentBounds.maxYWithoutBottomConstraint === "number";
  const bottomGapToCollapse = hasBottomConstrainedChildren && hasNonBottomContent
    ? contentBounds.bottomConstrainedGroupMinY - contentBounds.maxYWithoutBottomConstraint
    : 0;
  const shouldApplyBottomConstraintResize =
    hasBottomConstrainedChildren &&
    hasNonBottomContent &&
    bottomGapToCollapse > bottomConstraintGap + EPSILON &&
    (mode === "bottom" || mode === "all" || mode === "vertical");
  const bottomConstrainedHeight = shouldApplyBottomConstraintResize
    ? Math.max(0, contentBounds.bottomConstrainedGroupMaxY - contentBounds.bottomConstrainedGroupMinY)
    : 0;

  let newWidth = oldWidth;
  let newHeight = oldHeight;

  if (mode === "all" || mode === "horizontal") {
    newWidth = contentBounds.maxX - contentBounds.minX + padding * 2;
  } else if (mode === "left") {
    newWidth = oldWidth - contentBounds.minX + padding;
  } else if (mode === "right") {
    newWidth = contentBounds.maxX + padding;
  }

  if (mode === "all" || mode === "vertical") {
    if (shouldApplyBottomConstraintResize) {
      const nonBottomHeight = Math.max(0, contentBounds.maxYWithoutBottomConstraint - contentBounds.minY);
      const constrainedHeight = nonBottomHeight + bottomConstraintGap + bottomConstrainedHeight + padding * 2;
      newHeight = Math.min(standardHeight, constrainedHeight);
    } else {
      newHeight = standardHeight;
    }
  } else if (mode === "top") {
    newHeight = oldHeight - contentBounds.minY + padding;
  } else if (mode === "bottom") {
    if (shouldApplyBottomConstraintResize) {
      const constrainedBottomHeight =
        contentBounds.maxYWithoutBottomConstraint + bottomConstraintGap + bottomConstrainedHeight + padding;
      newHeight = Math.min(standardBottomHeight, constrainedBottomHeight);
    } else {
      newHeight = standardBottomHeight;
    }
  }

  newWidth = Math.max(1, newWidth);
  newHeight = Math.max(1, newHeight);

  const newX = mode === "left"
    ? oldX + oldWidth - newWidth
    : shouldTrimLeft(mode)
      ? oldX + contentBounds.minX - padding
      : oldX;
  const newY = mode === "top"
    ? oldY + oldHeight - newHeight
    : shouldTrimTop(mode)
      ? oldY + contentBounds.minY - padding
      : oldY;
  const shiftX = oldX - newX;
  const shiftY = oldY - newY;

  try {
    if (isAutoLayoutFrame(frame)) {
      const flow = contentBounds.flowBounds;
      if (shouldTrimLeft(mode) && "paddingLeft" in frame) {
        const target = Math.max(0, flow ? flow.minX + shiftX : padding);
        if (Math.abs(frame.paddingLeft - target) > EPSILON) frame.paddingLeft = target;
      }
      if (shouldTrimRight(mode) && "paddingRight" in frame) {
        const target = Math.max(0, flow ? newWidth - (flow.maxX + shiftX) : padding);
        if (Math.abs(frame.paddingRight - target) > EPSILON) frame.paddingRight = target;
      }
      if (shouldTrimTop(mode) && "paddingTop" in frame) {
        const target = Math.max(0, flow ? flow.minY + shiftY : padding);
        if (Math.abs(frame.paddingTop - target) > EPSILON) frame.paddingTop = target;
      }
      if (shouldTrimBottom(mode) && "paddingBottom" in frame) {
        const target = Math.max(0, flow ? newHeight - (flow.maxY + shiftY) : padding);
        if (Math.abs(frame.paddingBottom - target) > EPSILON) frame.paddingBottom = target;
      }
    }

    if (Math.abs(frame.width - newWidth) > EPSILON || Math.abs(frame.height - newHeight) > EPSILON) {
      frame.resizeWithoutConstraints(newWidth, newHeight);
    }
    if (Math.abs(frame.x - newX) > EPSILON) frame.x = newX;
    if (Math.abs(frame.y - newY) > EPSILON) frame.y = newY;
    restoreChildGeometry(preservedGeometry, shiftX, shiftY);

    if (shouldApplyBottomConstraintResize) {
      let currentBottom = Number.NEGATIVE_INFINITY;
      for (const child of contentBounds.bottomConstrainedChildren) {
        const bounds = getChildBoundsInFrame(child, frame);
        if (!bounds) continue;
        currentBottom = Math.max(currentBottom, bounds.maxY);
      }

      if (Number.isFinite(currentBottom)) {
        const targetBottom = newHeight - padding;
        const dy = targetBottom - currentBottom;
        if (Math.abs(dy) > EPSILON) {
          for (const child of contentBounds.bottomConstrainedChildren) {
            if ("y" in child) child.y += dy;
          }
        }
      }
    }
  } finally {
    restoreChildConstraints(frozenChildConstraints);
  }
}

function getSelectedFramesDeepestFirst() {
  const frames = figma.currentPage.selection.filter(isFrameNode);
  if (frames.length <= 1) return frames;
  return frames
    .map((frame) => ({ frame, depth: getNodeDepth(frame) }))
    .sort((a, b) => b.depth - a.depth)
    .map((entry) => entry.frame);
}

function ensureRelaunchData(frame) {
  if (typeof frame.getRelaunchData === "function") {
    const existing = frame.getRelaunchData();
    if (existing && existing[RELAUNCH_KEY] === RELAUNCH_LABEL) return;
  }
  frame.setRelaunchData({ [RELAUNCH_KEY]: RELAUNCH_LABEL });
}

function resizeSelectedFrames(mode, padding, gap, removeLastGap) {
  const frames = getSelectedFramesDeepestFirst();
  if (frames.length === 0) {
    figma.notify("Select at least one frame.");
    return;
  }

  const bottomConstraintGap = removeLastGap ? gap : 0;
  let resized = 0;
  let skipped = 0;
  let removedLastGapCount = 0;

  for (const frame of frames) {
    try {
      if (isInsideInstance(frame) || Math.abs(frame.rotation) > ROTATION_EPSILON) {
        skipped += 1;
        continue;
      }

      if (removeLastGap && collapseGapToImmediatePrevious(frame, gap)) {
        removedLastGapCount += 1;
      }

      const contentBounds = getContentBounds(frame);
      if (!contentBounds) {
        skipped += 1;
        continue;
      }

      applyBounds(frame, mode, contentBounds, padding, bottomConstraintGap);
      ensureRelaunchData(frame);
      resized += 1;
    } catch (_error) {
      skipped += 1;
    }
  }

  const total = frames.length;
  const summary = [`Done. Resized ${resized} of ${total} frame${total === 1 ? "" : "s"}`];

  if (removeLastGap) {
    summary.push(`Set the last gap to ${gap}px in ${removedLastGapCount} frame${removedLastGapCount === 1 ? "" : "s"}`);
  }

  if (skipped > 0) summary.push(`Skipped ${skipped}`);

  figma.notify(summary.join(". ") + ".");
  updateSelectionInfo();
}

function postSettingToUi(settingName) {
  if (!isUiReady) return;
  const def = SETTING_DEFS[settingName];
  figma.ui.postMessage({
    type: def.uiType,
    [settingName]: settings[settingName]
  });
}

function postAllSettingsToUi() {
  for (const name of Object.keys(SETTING_DEFS)) {
    postSettingToUi(name);
  }
}

async function loadSetting(settingName) {
  const def = SETTING_DEFS[settingName];
  let loadedValue = def.defaultValue;
  try {
    const saved = await figma.clientStorage.getAsync(def.key);
    loadedValue = def.sanitize(saved);
  } catch (_error) {
    loadedValue = def.defaultValue;
  }
  if (dirtySettings.has(settingName)) return;
  settings[settingName] = loadedValue;
  postSettingToUi(settingName);
}

function saveSetting(settingName, rawValue) {
  const def = SETTING_DEFS[settingName];
  const value = def.sanitize(rawValue);
  dirtySettings.add(settingName);
  if (settings[settingName] === value) return;
  settings[settingName] = value;

  const prev = settingWriteChains[settingName] || Promise.resolve();
  settingWriteChains[settingName] = prev.then(async () => {
    try {
      await figma.clientStorage.setAsync(def.key, settings[settingName]);
    } catch (_error) {
      // Ignore storage failures and keep plugin functional.
    }
  });
}

function getSanitizedResizePayload(msg) {
  return {
    mode: SETTING_DEFS.mode.sanitize(msg.mode),
    padding: SETTING_DEFS.padding.sanitize(msg.padding),
    gap: SETTING_DEFS.gap.sanitize(msg.gap),
    removeLastGap: SETTING_DEFS.removeLastGap.sanitize(msg.removeLastGap)
  };
}

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ui-size") {
    if (typeof msg.height === "number") {
      resizeUi(msg.height);
    }
    return;
  }

  if (msg.type === "ui-ready") {
    isUiReady = true;
    updateSelectionInfo(true);
    postAllSettingsToUi();
    return;
  }

  const settingName = SAVE_MESSAGE_TO_SETTING[msg.type];
  if (settingName) {
    saveSetting(settingName, msg[settingName]);
    return;
  }

  if (msg.type === "resize") {
    const payload = getSanitizedResizePayload(msg);
    saveSetting("mode", payload.mode);
    saveSetting("padding", payload.padding);
    saveSetting("gap", payload.gap);
    saveSetting("removeLastGap", payload.removeLastGap);

    resizeSelectedFrames(
      payload.mode,
      payload.padding,
      payload.gap,
      payload.removeLastGap
    );
  }
};

figma.on("selectionchange", () => updateSelectionInfo());
figma.on("currentpagechange", () => updateSelectionInfo());
for (const name of Object.keys(SETTING_DEFS)) {
  void loadSetting(name);
}
