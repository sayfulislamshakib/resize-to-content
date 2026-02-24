figma.showUI(__html__, { width: 348, height: 120 });

const MIN_UI_WIDTH = 290;
const MAX_UI_WIDTH = 290;
const MIN_UI_HEIGHT = 220;
const MAX_UI_HEIGHT = 900;

const MODE_LABELS = {
  all: "All sides",
  vertical: "Top and Bottom",
  horizontal: "Left and Right",
  top: "Top",
  right: "Right",
  bottom: "Bottom",
  left: "Left"
};

const SETTING_DEFS = {
  mode: {
    key: "resize-to-content.mode",
    defaultValue: "all",
    sanitize: sanitizeMode,
    uiType: "set-mode",
    field: "mode"
  },
  padding: {
    key: "resize-to-content.padding",
    defaultValue: 0,
    sanitize: sanitizeNonNegativeNumber,
    uiType: "set-padding",
    field: "padding"
  },
  gap: {
    key: "resize-to-content.gap",
    defaultValue: 0,
    sanitize: sanitizeNonNegativeNumber,
    uiType: "set-gap",
    field: "gap"
  },
  removeLastGap: {
    key: "resize-to-content.remove-last-gap",
    defaultValue: false,
    sanitize: sanitizeBoolean,
    uiType: "set-remove-last-gap",
    field: "removeLastGap"
  },
  removeAllGaps: {
    key: "resize-to-content.remove-all-gaps",
    defaultValue: false,
    sanitize: sanitizeBoolean,
    uiType: "set-remove-all-gaps",
    field: "removeAllGaps"
  }
};

const SAVE_MESSAGE_TO_SETTING = {
  "save-mode": "mode",
  "save-padding": "padding",
  "save-gap": "gap",
  "save-remove-last-gap": "removeLastGap",
  "save-remove-all-gaps": "removeAllGaps"
};

const settings = {
  mode: SETTING_DEFS.mode.defaultValue,
  padding: SETTING_DEFS.padding.defaultValue,
  gap: SETTING_DEFS.gap.defaultValue,
  removeLastGap: SETTING_DEFS.removeLastGap.defaultValue,
  removeAllGaps: SETTING_DEFS.removeAllGaps.defaultValue
};

const RELAUNCH_KEY = "open";
const RELAUNCH_LABEL = "";

let isUiReady = false;

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
  if (typeof value !== "string") return "all";
  return Object.prototype.hasOwnProperty.call(MODE_LABELS, value) ? value : "all";
}

function resizeUi(width, height) {
  const safeWidth = clamp(Math.round(width), MIN_UI_WIDTH, MAX_UI_WIDTH);
  const safeHeight = clamp(Math.round(height), MIN_UI_HEIGHT, MAX_UI_HEIGHT);
  try {
    figma.ui.resize(safeWidth, safeHeight);
  } catch (_error) {
    // Ignore invalid resize attempts.
  }
}

function isFrameNode(node) {
  return node.type === "FRAME";
}

function updateSelectionInfo() {
  const selection = figma.currentPage.selection;
  const frames = selection.filter(isFrameNode);
  figma.ui.postMessage({
    type: "selection-info",
    selected: selection.length,
    frameCount: frames.length
  });
}

function getChildBoundsInFrame(child, frame) {
  if (!child.visible) return null;

  if ("x" in child && "y" in child && "width" in child && "height" in child) {
    return {
      minX: child.x,
      minY: child.y,
      maxX: child.x + child.width,
      maxY: child.y + child.height
    };
  }

  if ("absoluteRenderBounds" in child && child.absoluteRenderBounds) {
    const frameAbsX = frame.absoluteTransform[0][2];
    const frameAbsY = frame.absoluteTransform[1][2];
    const abs = child.absoluteRenderBounds;

    return {
      minX: abs.x - frameAbsX,
      minY: abs.y - frameAbsY,
      maxX: abs.x + abs.width - frameAbsX,
      maxY: abs.y + abs.height - frameAbsY
    };
  }

  return null;
}

function getContentBounds(frame) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const child of frame.children) {
    const bounds = getChildBoundsInFrame(child, frame);
    if (!bounds) continue;

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
    found = true;
  }

  if (!found) return null;
  return { minX, minY, maxX, maxY };
}

function shouldTrimLeft(mode) {
  return mode === "all" || mode === "horizontal" || mode === "left";
}

function shouldTrimTop(mode) {
  return mode === "all" || mode === "vertical" || mode === "top";
}

function shiftChildren(frame, dx, dy) {
  if (dx === 0 && dy === 0) return;
  for (const child of frame.children) {
    if ("x" in child) child.x += dx;
    if ("y" in child) child.y += dy;
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

function getGapAxesForMode(mode) {
  const axisHint = getGapAxisHint(mode);
  return axisHint ? [axisHint] : ["x", "y"];
}

function getGapAxisHint(mode) {
  if (mode === "horizontal" || mode === "left" || mode === "right") return "x";
  if (mode === "vertical" || mode === "top" || mode === "bottom") return "y";
  return null;
}

function getOrderedGapEntries(frame, axisHint = null) {
  const entries = [];
  for (const child of frame.children) {
    if (!child.visible) continue;
    const bounds = getChildBoundsInFrame(child, frame);
    if (!bounds) continue;
    entries.push({ child, bounds });
  }

  if (entries.length < 2) return null;
  const axis = axisHint || getPrimaryAxisForGap(frame, entries);

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

function collapseGapToImmediatePrevious(frame, targetGap, axisHint = null) {
  const ordered = getOrderedGapEntries(frame, axisHint);
  if (!ordered) return false;

  const { axis, entries } = ordered;
  const lastEntry = entries[entries.length - 1];
  const prevEntry = entries[entries.length - 2];
  const lastChild = lastEntry.child;

  const gap = axis === "x"
    ? lastEntry.bounds.minX - prevEntry.bounds.maxX
    : lastEntry.bounds.minY - prevEntry.bounds.maxY;
  const delta = targetGap - gap;
  if (delta === 0) return false;

  try {
    if (axis === "x") {
      if (!("x" in lastChild)) return false;
      lastChild.x += delta;
    } else {
      if (!("y" in lastChild)) return false;
      lastChild.y += delta;
    }
    return true;
  } catch (_error) {
    if (frame.layoutMode !== "NONE" && typeof frame.itemSpacing === "number") {
      try {
        const hadChange = frame.itemSpacing !== targetGap;
        frame.itemSpacing = targetGap;
        return hadChange;
      } catch (_spacingError) {
        return false;
      }
    }
    return false;
  }
}

function collapseGapsForAllConsecutive(frame, targetGap, axisHint = null) {
  const ordered = getOrderedGapEntries(frame, axisHint);
  if (!ordered) return false;

  const { axis, entries } = ordered;
  let changed = false;
  let cumulativeShift = 0;
  let prevEnd = axis === "x" ? entries[0].bounds.maxX : entries[0].bounds.maxY;

  try {
    for (let i = 1; i < entries.length; i += 1) {
      const entry = entries[i];
      const start = (axis === "x" ? entry.bounds.minX : entry.bounds.minY) + cumulativeShift;
      const end = (axis === "x" ? entry.bounds.maxX : entry.bounds.maxY) + cumulativeShift;
      const gap = start - prevEnd;

      let delta = 0;
      if (gap > targetGap) {
        delta = targetGap - gap;
        cumulativeShift += delta;
        changed = true;
      }

      if (cumulativeShift !== 0) {
        if (axis === "x") {
          if (!("x" in entry.child)) return false;
          entry.child.x += cumulativeShift;
        } else {
          if (!("y" in entry.child)) return false;
          entry.child.y += cumulativeShift;
        }
      }

      prevEnd = end + delta;
    }

    return changed;
  } catch (_error) {
    if (frame.layoutMode !== "NONE" && typeof frame.itemSpacing === "number") {
      try {
        if (frame.itemSpacing <= targetGap) return false;
        frame.itemSpacing = targetGap;
        return true;
      } catch (_spacingError) {
        return false;
      }
    }
    return false;
  }
}

function applyBounds(frame, mode, contentBounds, padding) {
  const oldX = frame.x;
  const oldY = frame.y;
  const oldWidth = frame.width;
  const oldHeight = frame.height;

  let newWidth = oldWidth;
  let newHeight = oldHeight;

  if (mode === "all" || mode === "horizontal") {
    newWidth = contentBounds.maxX - contentBounds.minX + padding * 2;
  } else if (mode === "left") {
    newWidth = oldWidth - contentBounds.minX + padding;
  } else if (mode === "right") {
    newWidth = contentBounds.maxX + padding;
  } else if (mode !== "vertical" && mode !== "top" && mode !== "bottom") {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  if (mode === "all" || mode === "vertical") {
    newHeight = contentBounds.maxY - contentBounds.minY + padding * 2;
  } else if (mode === "top") {
    newHeight = oldHeight - contentBounds.minY + padding;
  } else if (mode === "bottom") {
    newHeight = contentBounds.maxY + padding;
  } else if (mode !== "horizontal" && mode !== "left" && mode !== "right") {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  newWidth = Math.max(1, newWidth);
  newHeight = Math.max(1, newHeight);

  const shiftX = shouldTrimLeft(mode) ? -contentBounds.minX + padding : 0;
  const shiftY = shouldTrimTop(mode) ? -contentBounds.minY + padding : 0;
  shiftChildren(frame, shiftX, shiftY);

  frame.resizeWithoutConstraints(newWidth, newHeight);
  frame.x = oldX;
  frame.y = oldY;
}

function resizeSelectedFrames(mode, padding, gap, removeLastGap, removeAllGaps) {
  const frames = figma.currentPage.selection.filter(isFrameNode);
  if (frames.length === 0) {
    figma.notify("Select at least one frame.");
    return;
  }

  const gapAxes = getGapAxesForMode(mode);
  const gapAxisHint = getGapAxisHint(mode);
  let resized = 0;
  let skippedNoContent = 0;
  let skippedRotation = 0;
  let skippedErrors = 0;
  let removedLastGapCount = 0;
  let removedAllGapsCount = 0;

  for (const frame of frames) {
    try {
      frame.setRelaunchData({ [RELAUNCH_KEY]: RELAUNCH_LABEL });

      if (frame.rotation !== 0) {
        skippedRotation += 1;
        continue;
      }

      if (removeAllGaps) {
        let changed = false;
        for (const axis of gapAxes) {
          if (collapseGapsForAllConsecutive(frame, gap, axis)) changed = true;
        }
        if (changed) removedAllGapsCount += 1;
      } else if (removeLastGap) {
        if (collapseGapToImmediatePrevious(frame, gap, gapAxisHint)) {
          removedLastGapCount += 1;
        }
      }

      const contentBounds = getContentBounds(frame);
      if (!contentBounds) {
        skippedNoContent += 1;
        continue;
      }

      applyBounds(frame, mode, contentBounds, padding);
      resized += 1;
    } catch (_error) {
      skippedErrors += 1;
    }
  }

  const total = frames.length;
  const summary = [`Done. Resized ${resized} of ${total} frame${total === 1 ? "" : "s"}`];

  if (removeAllGaps) {
    summary.push(`Set all consecutive gaps to ${gap}px in ${removedAllGapsCount} frame${removedAllGapsCount === 1 ? "" : "s"}`);
  } else if (removeLastGap) {
    summary.push(`Set the last gap to ${gap}px in ${removedLastGapCount} frame${removedLastGapCount === 1 ? "" : "s"}`);
  }

  const skippedTotal = skippedNoContent + skippedRotation + skippedErrors;
  if (skippedTotal > 0) summary.push(`Skipped ${skippedTotal}`);

  figma.notify(summary.join(". ") + ".");

  updateSelectionInfo();
}

function postSettingToUi(settingName) {
  if (!isUiReady) return;
  const def = SETTING_DEFS[settingName];
  figma.ui.postMessage({
    type: def.uiType,
    [def.field]: settings[settingName]
  });
}

function postAllSettingsToUi() {
  for (const name of Object.keys(SETTING_DEFS)) {
    postSettingToUi(name);
  }
}

async function loadSetting(settingName) {
  const def = SETTING_DEFS[settingName];
  try {
    const saved = await figma.clientStorage.getAsync(def.key);
    settings[settingName] = def.sanitize(saved);
  } catch (_error) {
    settings[settingName] = def.defaultValue;
  }
  postSettingToUi(settingName);
}

async function saveSetting(settingName, rawValue) {
  const def = SETTING_DEFS[settingName];
  const value = def.sanitize(rawValue);
  if (settings[settingName] === value) return;
  settings[settingName] = value;
  try {
    await figma.clientStorage.setAsync(def.key, value);
  } catch (_error) {
    // Ignore storage failures and keep plugin functional.
  }
}

function getSanitizedResizePayload(msg) {
  return {
    mode: SETTING_DEFS.mode.sanitize(msg.mode),
    padding: SETTING_DEFS.padding.sanitize(msg.padding),
    gap: SETTING_DEFS.gap.sanitize(msg.gap),
    removeLastGap: SETTING_DEFS.removeLastGap.sanitize(msg.removeLastGap),
    removeAllGaps: SETTING_DEFS.removeAllGaps.sanitize(msg.removeAllGaps)
  };
}

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ui-size") {
    if (typeof msg.width === "number" && typeof msg.height === "number") {
      resizeUi(msg.width, msg.height);
    }
    return;
  }

  if (msg.type === "ui-ready") {
    isUiReady = true;
    updateSelectionInfo();
    postAllSettingsToUi();
    return;
  }

  const settingName = SAVE_MESSAGE_TO_SETTING[msg.type];
  if (settingName) {
    const field = SETTING_DEFS[settingName].field;
    void saveSetting(settingName, msg[field]);
    return;
  }

  if (msg.type === "resize") {
    const payload = getSanitizedResizePayload(msg);
    void Promise.all([
      saveSetting("mode", payload.mode),
      saveSetting("padding", payload.padding),
      saveSetting("gap", payload.gap),
      saveSetting("removeLastGap", payload.removeLastGap),
      saveSetting("removeAllGaps", payload.removeAllGaps)
    ]);

    resizeSelectedFrames(
      payload.mode,
      payload.padding,
      payload.gap,
      payload.removeLastGap,
      payload.removeAllGaps
    );
  }
};

figma.on("selectionchange", updateSelectionInfo);
void Promise.all(Object.keys(SETTING_DEFS).map((name) => loadSetting(name)));
