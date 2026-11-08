/**
 * Background orchestration: context menus, keyboard commands, the omnibox, and
 * getting a composed prompt into TerrierGPT without leaving the page the user
 * is reading.
 *
 * Nothing is cached in module scope. The service worker is torn down after a
 * period of inactivity, so every listener reads what it needs from
 * chrome.storage and writes back what changed.
 *
 * Prompts are written into the composer. They are never placed in the URL:
 * a ticket in the query string would sit in Chrome's history and in server logs.
 */

import { INSTANCES, getSettings } from './lib/config.js';
import { extractFromPage, pickExtraction, presentPage } from './lib/extract.js';
import { makeCapture, compose, loadCaptures, addCapture } from './lib/prompt.js';
import { scopeKey, scopeOfTab } from './lib/scope.js';
import { describe } from './lib/messages.js';
import { chatURL, loadAgents, agentsFor, mergeDiscoveredAgents } from './lib/agents.js';
import { postJournalInPage, choosePostResult, postRequest } from './lib/journal.js';

/**
 * Chrome has a side panel. Safari does not, so there the same panel page is
 * docked inside the tab by `content/dock.js`, and the toolbar button toggles it.
 */
const HAS_SIDE_PANEL = typeof chrome.sidePanel?.open === 'function';

const MENU = {
  askSelection: 'tg-ask-selection',
  captureSelection: 'tg-capture-selection',
  capturePage: 'tg-capture-page',
  captureLink: 'tg-capture-link',
  openPanel: 'tg-open-panel',
};

// ------------------------------------------------------------------ lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  // Safari on iOS has no context menus; there the popup is the only way in.
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.askSelection,
      title: 'Ask TerrierGPT about "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.captureSelection,
      title: 'Add selection to TerrierGPT context',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.capturePage,
      title: 'Open this page in TerrierGPT',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU.captureLink,
      title: 'Add this link to TerrierGPT context',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU.openPanel,
      title: 'Open TerrierGPT panel',
      contexts: ['action'],
    });
  });

  await refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);
if (HAS_SIDE_PANEL) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[TerrierGPT] setPanelBehavior failed:', error));
} else {
  // Without a side panel the toolbar button (and Alt+Shift+T) toggles the dock.
  chrome.action.onClicked.addListener((tab) => void toggleDock(tab, 'toggle'));
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key === 'captures' || key.startsWith('captures:'))) void refreshBadge();
});
chrome.tabs.onActivated.addListener(() => void refreshBadge());

/** The panel scope a tab belongs to: its window in Chrome, the tab itself where panels dock. */
function panelScope(tab) {
  return scopeOfTab(tab, { perTab: !HAS_SIDE_PANEL });
}

/**
 * The tab a panel means. A panel names its window (Chrome) or tab (Safari);
 * with no scope, as from the iOS popup or the menu bar app, it is the active
 * tab of the focused window.
 */
async function scopeTab(scope) {
  if (Number.isInteger(scope?.tabId)) {
    try {
      return await chrome.tabs.get(scope.tabId);
    } catch {
      return null;
    }
  }
  if (Number.isInteger(scope?.windowId)) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: scope.windowId });
    return tab ?? null;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** Each window's badge counts that window's own context, not every window's. */
async function refreshBadge() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) {
      const captures = await loadCaptures(scopeKey(panelScope(tab)));
      const count = captures.filter((capture) => capture.enabled).length;
      await chrome.action.setBadgeText({ tabId: tab.id, text: count ? String(count) : '' });
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#338AFF' });
  } catch {}
}

// ------------------------------------------------------------------- capturing

function accessReason(error) {
  const detail = String(error);
  if (/cannot be scripted|extensions gallery|Cannot access contents of url/i.test(detail) && /chrome:|edge:|about:|chromewebstore/i.test(detail)) {
    return 'unsupported-page';
  }
  return 'no-access';
}

async function extractTab(tab) {
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    return { ok: false, reason: 'unsupported-page' };
  }
  const { maxPageChars } = await getSettings();
  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractFromPage,
      args: [maxPageChars],
    });
  } catch (error) {
    return { ok: false, reason: accessReason(error), detail: String(error) };
  }
  const frames = injected.map((entry) => entry?.result).filter(Boolean);
  const best = pickExtraction(frames);
  if (!best) return { ok: false, reason: 'no-content' };
  const page = presentPage(best, maxPageChars);
  if (!page?.body && !page?.selection) return { ok: false, reason: 'empty-page' };
  return { ok: true, page, maxPageChars };
}

async function capture(tab, { mode }) {
  const read = await extractTab(tab);
  if (!read.ok) return read;

  const page = read.page;
  const wantsSelection = mode === 'selection' || (mode === 'auto' && page.selection);
  const body = wantsSelection ? page.selection : page.body;
  if (!body) return { ok: false, reason: wantsSelection ? 'empty-selection' : 'empty-page' };

  const entry = makeCapture({
    source: wantsSelection ? 'selection' : 'page',
    title: wantsSelection ? 'Selection' : page.ticket?.number || page.title,
    detail: page.host,
    url: page.url,
    body,
    partial: !wantsSelection && page.truncated ? `Truncated at ${read.maxPageChars.toLocaleString()} characters` : null,
  });
  await addCapture(entry, scopeKey(panelScope(tab)));
  return { ok: true, capture: entry };
}

async function readKnownTab(tab) {
  const tabInfo = {
    title: tab?.title || '',
    url: tab?.url || '',
    host: '',
  };
  try {
    if (tab?.url) tabInfo.host = new URL(tab.url).host;
  } catch {}

  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    return { ok: false, reason: 'unsupported-page', tab: tabInfo, granted: false };
  }

  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] });
  } catch {}

  const read = await extractTab(tab);
  if (!read.ok) {
    return { ok: false, reason: read.reason, detail: read.detail, tab: tabInfo, granted };
  }
  return { ok: true, page: read.page, tab: tabInfo, granted: true };
}

async function readActiveTab(scope) {
  return readKnownTab(await scopeTab(scope));
}

// -------------------------------------------------------------------- sending

/**
 * A tab the panel owns, kept in the background so asking never steals the
 * ticket the user is looking at. The user's own TerrierGPT tab is left alone.
 */
async function ensureWorkerTab(instance, url, readingScope = null) {
  const { workerTabId, workerOrigin } = await chrome.storage.session.get(['workerTabId', 'workerOrigin']);
  if (workerTabId && workerOrigin === instance.origin) {
    try {
      const existing = await chrome.tabs.get(workerTabId);
      // If the user took the tab somewhere else, it is theirs now. Leave it be.
      if (!existing.url || existing.url.startsWith(`${instance.origin}/`)) return { tab: existing, fresh: false };
    } catch {
      // The user closed it. Open another below.
    }
  }
  const reading = await scopeTab(readingScope);
  const tab = await chrome.tabs.create({ url, active: false, ...(reading ? { windowId: reading.windowId } : {}) });
  // If the browser brought the new tab forward anyway, go back to the page being read.
  if (reading && reading.id !== tab.id) {
    const [now] = await chrome.tabs.query({ active: true, windowId: reading.windowId });
    if (now?.id === tab.id) await chrome.tabs.update(reading.id, { active: true }).catch(() => {});
  }
  await chrome.storage.session.set({ workerTabId: tab.id, workerOrigin: instance.origin });
  return { tab, fresh: true };
}

async function ensureTerrierTab(instance, url, { focus = false } = {}) {
  const matching = await chrome.tabs.query({ url: `${instance.origin}/*` });
  if (matching.length) {
    const current = await chrome.windows.getLastFocused();
    const preferred = matching.find((tab) => tab.windowId === current.id) ?? matching[0];
    if (focus) {
      await chrome.tabs.update(preferred.id, { active: true });
      await chrome.windows.update(preferred.windowId, { focused: true });
    }
    return { tab: preferred, fresh: false };
  }
  const tab = await chrome.tabs.create({ url, active: focus });
  return { tab, fresh: true };
}

async function navigate(tabId, url, timeout = 20000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url === url && tab?.status === 'complete') return true;
  } catch {}

  const settled = new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    function finish(loaded) {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(loaded);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await chrome.tabs.update(tabId, { url });
  return settled;
}

async function pingContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'TG_PING' });
    return Boolean(pong?.ok);
  } catch {
    return false;
  }
}

async function ensureComposerScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/composer.js'] });
  } catch {
    // Mid-navigation, or the tab went away. The next attempt retries.
  }
}

async function waitForContentScript(tabId, { attempts = 20, delayMs = 400 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (await pingContentScript(tabId)) return true;
    if (i % 4 === 0) await ensureComposerScript(tabId);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
}

/** Places a prompt in a TerrierGPT tab. Used when the user explicitly wants the composer. */
async function sendToTerrier({ instruction, captures, openAndFocus = true }) {
  const settings = await getSettings();
  const instance = INSTANCES[settings.instance];
  const text = compose(instruction, captures ?? (await loadCaptures()));
  if (!text.trim()) return { ok: false, reason: 'empty-prompt' };

  const agent = settings.agentId ? agentsFor(await loadAgents(), instance.origin).find((item) => item.id === settings.agentId) : null;
  const stamp = { instance: instance.id, agent: agent?.name ?? null, chars: text.length, via: 'composer' };
  const target = agent ? chatURL(instance.origin, agent.id) : `${instance.origin}/c/new`;
  const { tab, fresh } = await ensureTerrierTab(instance, target, { focus: openAndFocus });

  if (!fresh && tab.url !== target) await navigate(tab.id, target);
  if (!(await waitForContentScript(tab.id))) return { ok: false, reason: 'no-content-script' };

  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'TG_INJECT',
    payload: {
      text,
      autoSend: settings.autoSend,
      newChat: !agent && settings.newChatPerSend && !fresh,
    },
  });

  if (openAndFocus) await focusTab(tab);
  return { ...result, ...stamp };
}

/**
 * Asks in a background tab and returns the assistant's text.
 * The active tab stays the page the user is reading.
 */
async function markAlive(askId, stage) {
  if (!askId) return;
  try {
    await chrome.storage.session.set({ askAlive: { id: askId, stage, at: Date.now() } });
  } catch {}
}

async function storeAskResult(askId, result) {
  if (!askId) return;
  try {
    await chrome.storage.session.set({ askResult: { id: askId, result, at: Date.now() } });
  } catch {}
}

async function askToTerrier({ instruction, captures, askId = null }, scope = null) {
  const settings = await getSettings();
  const instance = INSTANCES[settings.instance];
  const text = compose(instruction, captures ?? (await loadCaptures()));
  if (!text.trim()) return { ok: false, reason: 'empty-prompt' };

  const agent = settings.agentId ? agentsFor(await loadAgents(), instance.origin).find((item) => item.id === settings.agentId) : null;
  const stamp = { instance: instance.id, agent: agent?.name ?? null, chars: text.length, via: 'composer' };
  const freshURL = agent ? chatURL(instance.origin, agent.id) : `${instance.origin}/c/new`;

  // The previous ask's result stays: its panel may still collect it by id.
  await chrome.storage.session.remove('liveAnswer');
  await markAlive(askId, 'opening');
  const { tab, fresh } = await ensureWorkerTab(instance, freshURL, scope);
  const keepConversation =
    !fresh &&
    !agent &&
    !settings.newChatPerSend &&
    typeof tab.url === 'string' &&
    tab.url.startsWith(`${instance.origin}/c/`) &&
    !tab.url.startsWith(`${instance.origin}/c/new`);

  // A tab we just opened is already pointed at freshURL. Updating it again reloads the page.
  if (!fresh && !keepConversation && !(tab.url === freshURL && tab.status === 'complete')) {
    await navigate(tab.id, freshURL);
  }

  await markAlive(askId, 'loading');
  if (!(await waitForContentScript(tab.id))) {
    await markAlive(askId, 'reloading');
    await navigate(tab.id, keepConversation ? tab.url : freshURL);
    if (!(await waitForContentScript(tab.id))) return { ok: false, reason: 'no-content-script' };
  }

  await markAlive(askId, 'sending');
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'TG_ASK_AND_WAIT',
    payload: { text, newChat: false, agentId: agent?.id, askId },
  });
  return { ...result, ...stamp };
}

/**
 * One TerrierGPT tab answers every panel, and it can only answer one question
 * at a time: a second ask used to navigate it away mid-answer, and the first
 * window got the second window's text, or nothing. Asks from any window now
 * wait their turn. A waiting ask reports itself alive so its panel does not
 * give up on it.
 */
let askChain = Promise.resolve();
let runningAskId = null;

function queueAskInWorker(payload, scope) {
  const askId = payload?.askId || null;
  const waiting = setInterval(() => void markAlive(askId, 'queued'), 20_000);
  void markAlive(askId, 'queued');
  const run = askChain.then(async () => {
    clearInterval(waiting);
    runningAskId = askId;
    try {
      return await askToTerrier(payload, scope);
    } finally {
      runningAskId = null;
    }
  });
  // The chain carries on whether this ask succeeded or threw.
  askChain = run.catch(() => {});
  return run.finally(() => clearInterval(waiting));
}

/**
 * The panel heard nothing for a long time. Ask the TerrierGPT tab directly
 * whether this ask finished: the tab keeps its last result in memory.
 */
async function collectAsk(askId) {
  const { workerTabId, askResult } = await chrome.storage.session.get(['workerTabId', 'askResult']);
  if (askResult?.id === askId && askResult.result) return { ok: true, done: true, result: askResult.result };
  if (!workerTabId) return { ok: true, done: false };
  try {
    const reply = await chrome.tabs.sendMessage(workerTabId, { type: 'TG_ASK_COLLECT', payload: { id: askId } });
    return reply && typeof reply === 'object' ? reply : { ok: true, done: false };
  } catch {
    return { ok: true, done: false };
  }
}

/**
 * Lists the account's agents through an open TerrierGPT tab, or a background
 * one opened for this and closed again. The content script asks LibreChat's
 * own API and falls back to reading the page.
 */
async function syncAccountAgents() {
  const settings = await getSettings();
  const instance = INSTANCES[settings.instance];
  const matching = await chrome.tabs.query({ url: `${instance.origin}/*` });
  let tabId;
  let opened = false;
  if (matching.length) {
    const current = await chrome.windows.getLastFocused();
    tabId = (matching.find((tab) => tab.windowId === current.id) ?? matching[0]).id;
  } else {
    const tab = await chrome.tabs.create({ url: `${instance.origin}/c/new`, active: false });
    tabId = tab.id;
    opened = true;
  }

  try {
    if (!(await waitForContentScript(tabId, { attempts: 30 }))) return { ok: false, reason: 'no-content-script' };

    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: 'TG_DISCOVER_AGENTS' });
    } catch {}
    if (!response?.ok) return { ok: false, reason: response?.reason || 'agents-api' };

    const found = Array.isArray(response.agents) ? response.agents : [];
    const merged = await mergeDiscoveredAgents(found, instance.origin);
    return {
      ok: true,
      agents: merged,
      count: agentsFor(merged, instance.origin).length,
      discoveredCount: found.length,
      source: response.source || 'page',
    };
  } finally {
    // A tab the user did not open should not outlive the sync.
    if (opened) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * Opens BU Login for the selected instance. `/oauth/openid` is where
 * LibreChat's own "BU Login" button goes, so this skips the login page.
 */
async function signIn(scope) {
  const settings = await getSettings();
  const instance = INSTANCES[settings.instance];
  const current = await scopeTab(scope);
  const tab = await chrome.tabs.create({
    url: `${instance.origin}/oauth/openid`,
    active: true,
    ...(current ? { index: current.index + 1, windowId: current.windowId } : {}),
  });
  return { ok: true, tabId: tab.id };
}

/**
 * Whether the selected instance is signed in, as an open TerrierGPT tab sees it.
 * Nothing is sent to the server: with no TerrierGPT tab open, the answer is unknown.
 */
async function sessionState() {
  const settings = await getSettings();
  const instance = INSTANCES[settings.instance];
  const tabs = await chrome.tabs.query({ url: `${instance.origin}/*` });
  let known = false;
  for (const tab of tabs) {
    if (tab.status !== 'complete') continue;
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'TG_PING' });
      if (!pong?.ok) continue;
      known = true;
      if (pong.signedIn) return { ok: true, known: true, signedIn: true, origin: instance.origin };
    } catch {}
  }
  return { ok: true, known, signedIn: false, origin: instance.origin };
}

async function openPanel(tab) {
  if (!HAS_SIDE_PANEL) {
    const result = await toggleDock(tab, 'open');
    if (!result.ok) throw new Error(result.reason);
    return;
  }
  const windowId = tab?.windowId ?? (await chrome.windows.getCurrent()).id;
  await chrome.sidePanel.open({ windowId });
}

/** Opens, closes, or toggles the in-page panel on a tab. Safari only. */
async function toggleDock(tab, mode) {
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id || !/^https?:/i.test(target.url || '')) {
    await toast(target?.id, describe('unsupported-page'), 'error');
    return { ok: false, reason: 'unsupported-page' };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['content/dock.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: (how, tabId) => globalThis.__tgDock?.[how](tabId),
      args: [mode, target.id],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: accessReason(error), detail: String(error) };
  }
}

/** The panel picks this up, reads the page, and asks without leaving it. */
async function queueAsk(tab, instruction, extra = {}) {
  await chrome.storage.session.set({
    pendingAsk: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      instruction: instruction ?? '',
      selection: extra.selection || '',
      url: extra.url || '',
      label: extra.label || '',
      // Only the panel for this tab answers: its window's side panel in Chrome,
      // its own dock in Safari.
      tabId: tab?.id ?? null,
      windowId: tab?.windowId ?? null,
    },
  });
  try {
    await openPanel(tab);
  } catch {
    await toast(tab?.id, 'Open the TerrierGPT panel to see the answer.', 'error');
  }
}

// -------------------------------------------------------------------- feedback

function showToast(message, tone) {
  const HOST_ID = '__terriergpt_toast__';
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.textContent = message;
  box.style.cssText = [
    'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'padding:10px 14px',
    'border-radius:12px',
    'max-width:320px',
    'color:#fff',
    `background:${tone === 'error' ? 'rgba(204,10,33,.88)' : 'rgba(28,28,31,.82)'}`,
    'backdrop-filter:blur(20px) saturate(180%)',
    '-webkit-backdrop-filter:blur(20px) saturate(180%)',
    'border:1px solid rgba(255,255,255,.18)',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 30px rgba(0,0,0,.30)',
    'opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease',
  ].join(';');
  root.appendChild(box);
  document.documentElement.appendChild(host);

  requestAnimationFrame(() => {
    box.style.opacity = '1';
    box.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    box.style.opacity = '0';
    setTimeout(() => host.remove(), 250);
  }, 2600);
}

async function toast(tabId, message, tone = 'info') {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showToast,
      args: [message, tone],
    });
  } catch {
    // Not scriptable. The panel still reports the same failure.
  }
}

// --------------------------------------------------------------- context menus

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU.openPanel || info.menuItemId === MENU.capturePage) {
    await chrome.storage.session.set({ reread: { at: Date.now(), tabId: tab?.id ?? null, windowId: tab?.windowId ?? null } });
    try {
      await openPanel(tab);
    } catch {
      await toast(tab?.id, describe('unsupported-page'), 'error');
    }
    return;
  }

  if (info.menuItemId === MENU.captureLink) {
    let host = info.linkUrl;
    try {
      host = new URL(info.linkUrl).hostname;
    } catch {}
    const entry = makeCapture({
      source: 'link',
      title: info.selectionText?.trim() || info.linkUrl,
      detail: host,
      url: info.linkUrl,
      body: info.linkUrl,
    });
    await addCapture(entry, scopeKey(panelScope(tab)));
    await toast(tab?.id, 'Link added to TerrierGPT context');
    return;
  }

  if (info.menuItemId === MENU.askSelection) {
    const read = await extractTab(tab);
    if (!read.ok) {
      await toast(tab?.id, describe(read.reason), 'error');
      return;
    }
    if (!read.page.selection) {
      await toast(tab?.id, describe('empty-selection'), 'error');
      return;
    }
    await queueAsk(tab, 'Explain the selected text and say what I should do next.', {
      selection: read.page.selection,
      url: read.page.url,
      label: 'Selection',
    });
    return;
  }

  const result = await capture(tab, { mode: 'selection' });
  await toast(tab?.id, result.ok ? 'Selection added to TerrierGPT context' : describe(result.reason), result.ok ? 'info' : 'error');
});

// ------------------------------------------------------------------- commands

// Keyboard commands do not exist on iOS.
chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (command === 'capture-page') {
    await chrome.storage.session.set({ reread: { at: Date.now(), tabId: tab?.id ?? null, windowId: tab?.windowId ?? null } });
    try {
      await openPanel(tab);
    } catch {
      await toast(tab?.id, describe('unsupported-page'), 'error');
    }
    return;
  }

  if (command === 'send-capture') {
    await queueAsk(tab, '');
  }
});

// -------------------------------------------------------------------- omnibox

// Safari has no omnibox. The keyword is a Chrome-only shortcut.
chrome.omnibox?.onInputChanged.addListener((text, suggest) => {
  chrome.omnibox.setDefaultSuggestion({
    description: `Ask TerrierGPT: <match>${escapeXml(text)}</match>`,
  });
  suggest([]);
});

chrome.omnibox?.onInputEntered.addListener(async (text) => {
  const instruction = text.trim();
  if (!instruction) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await queueAsk(tab, instruction, { label: 'Ask' });
});

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[char]};`);
}

// ---------------------------------------------------- menu bar native host
//
// The port has to live for the life of the worker. Chrome starts the host,
// and the host's heartbeat is how the menu knows a capture can ask us for the
// page instead of using AppleScript. A missing host is not an error until the
// user asks to send something.

const NATIVE_HOST = 'com.brianmatute.terriergpt.companion';

/**
 * Safari routes native messages to the app extension inside TerrierGPT Menu
 * (SafariWebExtensionHandler), one request and one reply, not to a host
 * process Chrome starts. The build sets this flag for the Safari copy.
 */
const SAFARI_IOS = globalThis.TG_TARGET === 'safari-ios';
const SAFARI_NATIVE = globalThis.TG_TARGET === 'safari' || SAFARI_IOS;
// iOS ignores the identifier and always answers from the containing app's extension.
const SAFARI_APP_ID = SAFARI_IOS ? 'edu.bu.TerrierGPT' : 'com.brianmatute.TerrierGPTMenu';

let nativePort = null;
const pendingHost = new Map();

function failPendingHost(reason) {
  for (const pending of pendingHost.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, reason });
  }
  pendingHost.clear();
}

function connectHost() {
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener(() => {
      nativePort = null;
      failPendingHost('bridge-missing');
    });
    return port;
  } catch {
    nativePort = null;
    return null;
  }
}

function onHostMessage(message) {
  if (message?.op === 'read-page' && message.id) {
    void answerPageRead(message.id);
    return;
  }
  const pending = message?.id && pendingHost.get(message.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHost.delete(message.id);
  pending.resolve(message);
}

async function requestSafariApp(message) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(SAFARI_APP_ID, message);
    return reply && typeof reply === 'object' ? reply : { ok: false, reason: 'bridge-failed' };
  } catch {
    return { ok: false, reason: 'bridge-missing' };
  }
}

function requestHost(message) {
  if (SAFARI_NATIVE) return requestSafariApp(message);
  return new Promise((resolve) => {
    const port = connectHost();
    if (!port) {
      resolve({ ok: false, reason: 'bridge-missing' });
      return;
    }
    const timer = setTimeout(() => {
      pendingHost.delete(message.id);
      resolve({ ok: false, reason: 'bridge-failed' });
    }, 8000);
    pendingHost.set(message.id, { resolve, timer });
    try {
      port.postMessage(message);
    } catch {
      clearTimeout(timer);
      pendingHost.delete(message.id);
      nativePort = null;
      resolve({ ok: false, reason: 'bridge-missing' });
    }
  });
}

async function catalogFromHost() {
  const reply = await requestHost({ op: 'catalog', id: crypto.randomUUID() });
  if (reply?.ok && Array.isArray(reply.catalog?.actions)) {
    await chrome.storage.session.set({ browserCatalog: reply.catalog });
    return { ok: true, catalog: reply.catalog };
  }
  const stored = await chrome.storage.session.get('browserCatalog');
  if (Array.isArray(stored.browserCatalog?.actions)) {
    return { ok: true, catalog: stored.browserCatalog, cached: true };
  }
  return { ok: false, reason: reply?.reason || 'no-catalog' };
}

async function postJournal(payload, scope) {
  const prepared = postRequest(payload || {});
  if (!prepared.ok) return prepared;
  const tab = await scopeTab(scope);
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    return { ok: false, reason: 'unsupported-page' };
  }
  let injected;
  try {
    // MAIN world: g_form and g_ck live on the page, not in the extension's isolated world.
    injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: postJournalInPage,
      args: [{ field: prepared.field, text: prepared.text, expectNumber: prepared.expectNumber }],
    });
  } catch (error) {
    return { ok: false, reason: accessReason(error), detail: String(error) };
  }
  return choosePostResult(injected);
}

/**
 * iOS: hands the page, selection, or ticket to TerrierGPT for iPhone through its app
 * extension, which drops it in the app's context tray. When TerrierGPT is open on the
 * other half of the screen it arrives on its own; otherwise the popup offers to open it.
 */
async function sendToApp(payload = {}) {
  if (!SAFARI_IOS) return { ok: false, reason: 'unknown-message' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const read = await extractTab(tab);
  if (!read.ok) return read;

  const page = read.page;
  const wantsSelection = payload.mode === 'selection' || (payload.mode === 'auto' && page.selection);
  const body = wantsSelection ? page.selection : page.body;
  if (!body) return { ok: false, reason: wantsSelection ? 'empty-selection' : 'empty-page' };

  const ticket = !wantsSelection && page.kind === 'ticket' ? page.ticket : null;
  const reply = await requestHost({
    op: 'capture',
    id: crypto.randomUUID(),
    kind: wantsSelection ? 'selection' : ticket ? 'ticket' : 'page',
    title: wantsSelection ? 'Selection' : ticket?.shortDescription || page.title || page.host || 'Page',
    url: page.url || '',
    body: body.slice(0, read.maxPageChars),
    ticketNumber: ticket?.number || '',
  });
  return reply?.ok ? { ok: true, kind: wantsSelection ? 'selection' : ticket ? 'ticket' : 'page' } : reply;
}

async function handoffToMenu(payload) {
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, reason: 'empty-prompt' };
  return requestHost({
    op: 'handoff',
    id: crypto.randomUUID(),
    text,
    title: String(payload.title || ''),
    url: String(payload.url || ''),
    wake: payload.wake === true,
  });
}

async function answerPageRead(id) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const read = await readKnownTab(tab);
  const port = nativePort;
  if (!port) return;
  if (!read.ok) {
    try {
      port.postMessage({ op: 'read-page', id, ok: false, reason: read.reason || 'no-content' });
    } catch {}
    return;
  }
  const page = read.page;
  try {
    port.postMessage({
      op: 'read-page',
      id,
      ok: true,
      title: page.ticket?.number || page.title || '',
      detail: page.ticket?.shortDescription || page.host || '',
      url: page.url || '',
      host: page.host || '',
      body: page.body || '',
      selection: page.selection || '',
      kind: page.kind || 'page',
    });
  } catch {}
}

async function activeHttpTab(scope) {
  const tab = await scopeTab(scope);
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) return null;
  return tab;
}

async function armPicker(scope) {
  const tab = await activeHttpTab(scope);
  if (!tab) return { ok: false, reason: 'unsupported-page' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content/picker.js'],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: accessReason(error), detail: String(error) };
  }
}

async function disarmPicker(scope) {
  const tab = await activeHttpTab(scope);
  if (!tab) return { ok: true };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => globalThis.__tgPicker?.disarm(),
    });
  } catch {}
  return { ok: true };
}

// Chrome only: keep the host process alive so the menu can ask for the page.
// Safari has no long-lived host; the menu reads Safari over AppleScript.
if (!SAFARI_NATIVE) {
  chrome.alarms.create('tg-host', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'tg-host') connectHost();
  });
  connectHost();
}

// -------------------------------------------------------- messages from the UI

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // A panel says which window (Chrome) or tab (Safari) it belongs to.
  const scope = message?.scope ?? null;
  (async () => {
    try {
      switch (message?.type) {
        case 'TG_READ_ACTIVE_TAB':
          sendResponse(await readActiveTab(scope));
          break;
        case 'TG_CAPTURE_ACTIVE_TAB': {
          const tab = await scopeTab(scope);
          sendResponse(await capture(tab, { mode: message.mode ?? 'auto' }));
          break;
        }
        case 'TG_SEND': {
          const result = await sendToTerrier(message.payload ?? {});
          sendResponse(result);
          break;
        }
        case 'TG_ASK': {
          const askId = message.payload?.askId || null;
          let result;
          try {
            result = await queueAskInWorker(message.payload ?? {}, scope);
          } catch (error) {
            result = { ok: false, reason: 'exception', detail: String(error) };
          }
          // A tab-side result (TG_ASK_RESULT) may already be stored; keep the richer one.
          const stored = (await chrome.storage.session.get('askResult')).askResult;
          if (result?.ok || !(stored?.id === askId && stored.result?.ok)) {
            await storeAskResult(askId, result);
          }
          sendResponse(result);
          break;
        }
        case 'TG_ASK_RESULT': {
          if (message.payload?.id && message.payload.result) await storeAskResult(message.payload.id, message.payload.result);
          sendResponse({ ok: true });
          break;
        }
        case 'TG_ASK_ALIVE':
          await markAlive(message.payload?.id, message.payload?.stage || 'tab');
          sendResponse({ ok: true });
          break;
        case 'TG_ASK_COLLECT':
          sendResponse(await collectAsk(message.payload?.id));
          break;
        case 'TG_SIGN_IN':
          sendResponse(await signIn(scope));
          break;
        case 'TG_SESSION':
          sendResponse(await sessionState());
          break;
        case 'TG_SYNC_AGENTS':
          sendResponse(await syncAccountAgents());
          break;
        case 'TG_AGENT_DISCOVERED': {
          let origin = null;
          try {
            origin = new URL(_sender?.tab?.url || '').origin;
          } catch {}
          if (message.payload?.id) await mergeDiscoveredAgents([message.payload], origin);
          sendResponse({ ok: true });
          break;
        }
        case 'TG_STOP_GENERATION': {
          // Stop only the answer this panel is waiting for, never another window's.
          const wanted = message.payload?.askId || null;
          const { workerTabId } = await chrome.storage.session.get('workerTabId');
          if (workerTabId && (!wanted || wanted === runningAskId)) {
            try {
              await chrome.tabs.sendMessage(workerTabId, { type: 'TG_STOP_GENERATION' });
            } catch {}
          }
          sendResponse({ ok: true });
          break;
        }
        case 'TG_FOCUS_TAB': {
          const { workerTabId } = await chrome.storage.session.get('workerTabId');
          let tab = null;
          if (workerTabId) {
            try {
              tab = await chrome.tabs.get(workerTabId);
            } catch {}
          }
          if (tab) {
            await focusTab(tab);
            sendResponse({ ok: true });
          } else {
            const settings = await getSettings();
            const instance = INSTANCES[settings.instance];
            const created = await chrome.tabs.create({ url: message.url || `${instance.origin}/c/new`, active: true });
            sendResponse({ ok: true, tabId: created.id });
          }
          break;
        }
        case 'TG_STREAM_UPDATE': {
          const text = message.payload?.text || '';
          if (text) await chrome.storage.session.set({ liveAnswer: { id: message.payload?.id || null, text, at: Date.now() } });
          sendResponse({ ok: true });
          break;
        }
        case 'TG_PICK':
          sendResponse(await armPicker(scope));
          break;
        case 'TG_PICK_STOP':
          sendResponse(await disarmPicker(scope));
          break;
        case 'TG_PICKED':
        case 'TG_PICK_CANCELLED':
        case 'TG_PICK_EMPTY':
          sendResponse({ ok: true });
          break;
        case 'TG_HANDOFF':
          sendResponse(await handoffToMenu(message.payload ?? {}));
          break;
        case 'TG_SEND_TO_APP':
          sendResponse(await sendToApp(message.payload ?? {}));
          break;
        case 'TG_OPEN_DOCK':
          sendResponse(await toggleDock(null, 'open'));
          break;
        case 'TG_POST_JOURNAL':
          sendResponse(await postJournal(message.payload ?? {}, scope));
          break;
        case 'TG_CATALOG':
          sendResponse(await catalogFromHost());
          break;
        case 'TG_ACTIVE_TAB_INFO': {
          const tab = await scopeTab(scope);
          sendResponse({
            ok: true,
            title: tab?.title ?? '',
            url: tab?.url ?? '',
            scriptable: Boolean(tab?.url && /^https?:/i.test(tab.url)),
          });
          break;
        }
        default:
          sendResponse({ ok: false, reason: 'unknown-message' });
      }
    } catch (error) {
      sendResponse({ ok: false, reason: 'exception', detail: String(error) });
    }
  })();
  return true;
});
