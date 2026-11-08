#!/usr/bin/env node
/**
 * Two browser windows, one panel each. Every read, capture, pick, post, and
 * queued ask stays in the window (Chrome) or tab (Safari dock) it came from,
 * and one window's question never runs over the other's in the shared
 * TerrierGPT tab.
 *
 * Loads the real worker (bundled into one script, as the Safari build does)
 * against a fake `chrome` with two windows, window 2 focused last.
 *
 *     node tools/test-windows.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { bundleWorker } = await import(pathToFileURL(join(ROOT, 'tools/build.mjs')).href);
const { scopeKey, scopeOfTab, inScope } = await import(pathToFileURL(join(ROOT, 'lib/scope.js')).href);

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'}    ${name}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scope.js
check('a window scope keys by window', scopeKey({ windowId: 3 }) === 'w3');
check('a tab scope keys by tab', scopeKey({ tabId: 9 }) === 't9');
check('no scope keys as the shared list', scopeKey(null) === '');
check('Chrome scopes a tab to its window', JSON.stringify(scopeOfTab({ id: 5, windowId: 2 })) === '{"windowId":2}');
check('Safari scopes a tab to itself', JSON.stringify(scopeOfTab({ id: 5, windowId: 2 }, { perTab: true })) === '{"tabId":5}');
check('a tab in another window is not in scope', !inScope({ windowId: 1 }, { tabId: 21, windowId: 2 }));
check('another tab is not in a dock scope', !inScope({ tabId: 11 }, { tabId: 12, windowId: 1 }));

// ---------------------------------------------------------- a fake browser
const ORIGIN = 'https://terriergpt.bu.edu';
const tabs = [
  { id: 11, windowId: 1, active: true, url: 'https://one.example/ticket', title: 'Window one' },
  { id: 12, windowId: 1, active: false, url: 'https://one.example/other', title: 'Window one, other tab' },
  { id: 21, windowId: 2, active: true, url: 'https://two.example/page', title: 'Window two' },
];
const FOCUSED = 2;
let nextTab = 90;

const listeners = {};
const on = (name) => ({ addListener: (fn) => { (listeners[name] ??= []).push(fn); }, removeListener: () => {} });
const store = (seed = {}) => {
  const data = { ...seed };
  return {
    data,
    get: async (k) => {
      if (typeof k === 'string') return { [k]: data[k] };
      if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, data[x]]));
      if (k && typeof k === 'object') return Object.fromEntries(Object.entries(k).map(([x, v]) => [x, data[x] ?? v]));
      return { ...data };
    },
    set: async (o) => { Object.assign(data, o); },
    remove: async (k) => { for (const x of [].concat(k)) delete data[x]; },
    onChanged: on('storage'),
  };
};

const calls = { scripts: [], badges: [], askOrder: [] };
const session = store();
const chrome = {
  runtime: {
    onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'),
    connectNative: () => { throw new Error('no host in tests'); },
    getManifest: () => ({ host_permissions: [] }),
  },
  storage: { session, sync: store(), local: store() },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  action: {
    onClicked: on('action'),
    setBadgeText: async (o) => { calls.badges.push(o); },
    setBadgeBackgroundColor: async () => {},
  },
  contextMenus: { onClicked: on('menus'), removeAll: (cb) => cb?.(), create: () => {} },
  commands: { onCommand: on('commands') },
  omnibox: { onInputChanged: on('omniChanged'), onInputEntered: on('omniEntered'), setDefaultSuggestion: () => {} },
  alarms: { create: () => {}, onAlarm: on('alarm') },
  permissions: { contains: async () => true },
  windows: {
    getCurrent: async () => ({ id: FOCUSED }),
    getLastFocused: async () => ({ id: FOCUSED }),
    update: async () => {},
  },
  tabs: {
    onUpdated: on('tabsUpdated'), onActivated: on('tabsActivated'), onRemoved: on('tabsRemoved'),
    query: async (q = {}) => tabs.filter((t) =>
      (q.active === undefined || t.active === q.active) &&
      (q.windowId === undefined || t.windowId === q.windowId) &&
      (!(q.lastFocusedWindow || q.currentWindow) || t.windowId === FOCUSED) &&
      (q.url === undefined || t.url.startsWith(q.url.replace(/\*$/, '')))),
    get: async (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error('No tab');
      return tab;
    },
    create: async ({ url, windowId }) => {
      const tab = { id: nextTab++, windowId: windowId ?? FOCUSED, active: false, url, status: 'complete' };
      tabs.push(tab);
      return tab;
    },
    update: async () => ({}),
    sendMessage: async (tabId, message) => {
      if (message.type === 'TG_PING') return { ok: true, signedIn: true };
      if (message.type === 'TG_ASK_AND_WAIT') {
        calls.askOrder.push(`start ${message.payload.askId}`);
        await sleep(60);
        calls.askOrder.push(`end ${message.payload.askId}`);
        return { ok: true, text: `answer for ${message.payload.askId}` };
      }
      if (message.type === 'TG_STOP_GENERATION') {
        calls.stopped = (calls.stopped || 0) + 1;
        return { ok: true };
      }
      return { ok: true };
    },
  },
  scripting: {
    executeScript: async (opts) => {
      calls.scripts.push(opts);
      const tab = tabs.find((t) => t.id === opts.target.tabId);
      if (opts.func?.name === 'extractFromPage') {
        return [{ result: { title: tab.title, url: tab.url, host: new URL(tab.url).host, selection: '', pageText: `Text of ${tab.title}. `.repeat(20), truncated: false, ticket: null } }];
      }
      if (opts.func?.name === 'postJournalInPage') return [{ result: { ok: true, number: 'INC0000001', confirmed: true } }];
      return [{ result: undefined }];
    },
  },
};

const sandbox = { chrome, console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, structuredClone };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const worker = bundleWorker(join(ROOT, 'service-worker.js'));
let loadError = null;
try {
  vm.runInContext(worker, sandbox, { filename: 'service-worker.js' });
} catch (error) {
  loadError = error;
}
check(`the Chrome worker loads${loadError ? ` (${loadError.message})` : ''}`, !loadError);

const send = (message) => new Promise((resolve) => {
  listeners.message[0](message, {}, resolve);
});

// ---------------------------------------------------------- reading the page
const one = await send({ type: 'TG_READ_ACTIVE_TAB', scope: { windowId: 1 } });
check('window 1 reads its own page while window 2 is focused', one?.page?.url === 'https://one.example/ticket');
const two = await send({ type: 'TG_READ_ACTIVE_TAB', scope: { windowId: 2 } });
check('window 2 reads its own page', two?.page?.url === 'https://two.example/page');
const docked = await send({ type: 'TG_READ_ACTIVE_TAB', scope: { tabId: 12 } });
check('a docked panel reads its own tab, even in the background', docked?.page?.url === 'https://one.example/other');
const unscoped = await send({ type: 'TG_READ_ACTIVE_TAB' });
check('no scope (menu app, iOS popup) still means the focused window', unscoped?.page?.url === 'https://two.example/page');

// ----------------------------------------------------------------- context
await listeners.menus[0]({ menuItemId: 'tg-capture-link', linkUrl: 'https://two.example/link' }, tabs[2]);
check('a link captured in window 2 goes to window 2', (session.data['captures:w2'] || []).length === 1);
check('and not to window 1', !(session.data['captures:w1'] || []).length);
check('nor to one list every window shares', !(session.data.captures || []).length);

await listeners.menus[0]({ menuItemId: 'tg-open-panel' }, tabs[2]);
check('a re-read names the window it is for', session.data.reread?.windowId === 2 && session.data.reread?.tabId === 21);

await listeners.omniEntered[0]('What is this page?');
check('a queued ask names its window', session.data.pendingAsk?.windowId === FOCUSED && session.data.pendingAsk?.tabId === 21);

// ------------------------------------------------------------ pick and post
calls.scripts.length = 0;
await send({ type: 'TG_PICK', scope: { windowId: 1 } });
check('Pick arms the page in the panel\'s window', calls.scripts.some((s) => s.files?.includes('content/picker.js') && s.target.tabId === 11));
check('and not the focused window\'s page', !calls.scripts.some((s) => s.files?.includes('content/picker.js') && s.target.tabId === 21));

calls.scripts.length = 0;
const posted = await send({ type: 'TG_POST_JOURNAL', scope: { windowId: 1 }, payload: { field: 'work_notes', text: 'Checked the queue.', expectNumber: 'INC0000001' } });
check('a post goes to the ticket in the panel\'s window', posted?.ok && calls.scripts.some((s) => s.func?.name === 'postJournalInPage' && s.target.tabId === 11));

// ----------------------------------------------------------------- badges
calls.badges.length = 0;
await session.set({ 'captures:w1': [{ id: 'x', enabled: true, body: 'a' }, { id: 'y', enabled: true, body: 'b' }] });
for (const fn of listeners.storage || []) fn({ 'captures:w1': { newValue: [] } }, 'session');
await sleep(20);
const badge = (tabId) => calls.badges.filter((b) => b.tabId === tabId).at(-1)?.text;
check('each window\'s badge counts its own context', badge(11) === '2' && badge(21) === '1');

// ------------------------------------------------------------------- asking
calls.askOrder.length = 0;
const asks = await Promise.all([
  send({ type: 'TG_ASK', scope: { windowId: 1 }, payload: { instruction: 'One?', captures: [], askId: 'ask-one' } }),
  send({ type: 'TG_ASK', scope: { windowId: 2 }, payload: { instruction: 'Two?', captures: [], askId: 'ask-two' } }),
]);
check('each window gets its own answer', asks[0]?.text === 'answer for ask-one' && asks[1]?.text === 'answer for ask-two');
check('the second question waits for the first in the TerrierGPT tab',
  calls.askOrder.join(',') === 'start ask-one,end ask-one,start ask-two,end ask-two');

calls.stopped = 0;
await send({ type: 'TG_STOP_GENERATION', payload: { askId: 'someone-else' } });
check('Stop does not stop another window\'s answer', calls.stopped === 0);

// ------------------------------------------------------------- the panel
const panel = readFileSync(join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
check('the panel learns its own window', panel.includes('chrome.windows.getCurrent()'));
check('every message to the worker carries the panel\'s scope', /chrome\.runtime\.sendMessage\(scope \? \{ \.\.\.message, scope \}/.test(panel));
check('tab switches in other windows do not refresh this panel', /onActivated\.addListener\(\(info\) => \{\s*if \(isMine\(/.test(panel));
check('another window\'s pick is ignored', panel.includes("/^TG_PICK/.test(message?.type || '') && !isMine("));
check('another ask\'s streamed text is never shown', !panel.includes('|| !live.id'));
check('only the asking window takes a queued ask', panel.includes('!isMine(DOCKED ? { tabId: target.tabId } : target)'));
check('context is kept per window', panel.includes('loadScoped(scopeKey(await scopeReady))'));

console.log(failures ? `\n${failures} failing.` : '\nAll window tests passed.');
process.exit(failures ? 1 : 0);
