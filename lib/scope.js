/**
 * Which part of the browser a panel belongs to.
 *
 * Chrome opens one side panel per window, so a panel reads the active tab of
 * its own window. Safari docks one panel per tab, so a docked panel reads its
 * own tab. Without this, every panel read the active tab of whichever window
 * was focused last, and two windows saw, captured, and asked about each
 * other's pages.
 *
 * A scope is `{ windowId }`, `{ tabId }`, or null for "the focused window",
 * which is what the menu bar app and the iOS popup mean.
 */

/** The storage suffix for a scope: `w12`, `t345`, or '' for none. */
export function scopeKey(scope) {
  if (Number.isInteger(scope?.tabId)) return `t${scope.tabId}`;
  if (Number.isInteger(scope?.windowId)) return `w${scope.windowId}`;
  return '';
}

/** The scope a tab's panel has: its window in Chrome, the tab itself where panels dock per tab. */
export function scopeOfTab(tab, { perTab = false } = {}) {
  if (!tab) return null;
  if (perTab) return Number.isInteger(tab.id) ? { tabId: tab.id } : null;
  return Number.isInteger(tab.windowId) ? { windowId: tab.windowId } : null;
}

/** Whether a tab (or a tab event's ids) belongs to a scope. No scope matches everything. */
export function inScope(scope, { tabId, windowId } = {}) {
  if (Number.isInteger(scope?.tabId)) return tabId === scope.tabId;
  if (Number.isInteger(scope?.windowId)) return windowId === scope.windowId;
  return true;
}
