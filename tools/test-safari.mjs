#!/usr/bin/env node
/**
 * Tests for the Safari build: the manifest Safari accepts, a worker that
 * loads as a classic script with no side panel or omnibox, the dock instead
 * of the panel, and native messages that go to TerrierGPT Menu's app extension.
 *
 *     node tools/test-safari.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = mkdtempSync(join(tmpdir(), 'tg-safari-'));

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'}    ${name}`);
  if (!ok) failures += 1;
};

try {
  execFileSync(process.execPath, [join(ROOT, 'tools/build.mjs'), 'safari', '--out', OUT], { stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const worker = readFileSync(join(OUT, 'service-worker.js'), 'utf8');

  // --------------------------------------------------------------- manifest
  for (const key of ['side_panel', 'omnibox', 'key', 'minimum_chrome_version']) {
    check(`manifest drops ${key}`, !(key in manifest));
  }
  check('the worker is not a module', !manifest.background.type);
  check('sidePanel and clipboardRead are not requested', !manifest.permissions.includes('sidePanel') && !manifest.permissions.includes('clipboardRead'));
  check('native messaging stays', manifest.permissions.includes('nativeMessaging'));
  check('options do not ask for a tab', !('open_in_tab' in (manifest.options_ui ?? {})));
  check('the panel page is web-accessible for the dock', manifest.web_accessible_resources?.[0]?.resources.includes('sidepanel/*'));
  check('no default popup, so the button toggles the dock', !manifest.action.default_popup);
  for (const file of ['content/dock.js', 'content/picker.js', 'content/composer.js', 'sidepanel/sidepanel.html', 'options/options.html']) {
    check(`ships ${file}`, existsSync(join(OUT, file)));
  }

  // ----------------------------------------------------------------- worker
  check('the worker has no import or export left', !/^\s*(import|export)\s/m.test(worker));
  check('the worker knows it is the Safari copy', worker.startsWith('// Built') && worker.includes("globalThis.TG_TARGET = 'safari';"));

  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] ??= []).push(fn); } });
  const calls = { native: [], scripts: [], alarms: 0, connectNative: 0 };
  const store = () => {
    const data = {};
    return {
      get: async (k) => (typeof k === 'string' ? { [k]: data[k] } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, data[x]])) : { ...k, ...data }),
      set: async (o) => Object.assign(data, o),
      remove: async (k) => { delete data[k]; },
      onChanged: on('storage'),
    };
  };
  const chrome = {
    runtime: {
      onInstalled: on('onInstalled'), onStartup: on('onStartup'), onMessage: on('onMessage'),
      connectNative: () => { calls.connectNative += 1; throw new Error('no host'); },
      sendNativeMessage: async (app, message) => {
        calls.native.push({ app, message });
        return message.op === 'catalog'
          ? { ok: true, op: 'catalog', catalog: { actions: [{ id: 'triage' }] } }
          : { ok: true, op: message.op, path: '/tmp/x.json' };
      },
    },
    storage: { session: store(), sync: store(), local: store() },
    action: { onClicked: on('actionClicked'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    contextMenus: { onClicked: on('menus'), removeAll: (cb) => cb?.(), create: () => {} },
    commands: { onCommand: on('commands') },
    alarms: { create: () => { calls.alarms += 1; }, onAlarm: on('alarm') },
    tabs: {
      query: async () => [{ id: 7, url: 'https://bu.service-now.com/incident.do', windowId: 1 }],
      onUpdated: on('tabsUpdated'), onActivated: on('tabsActivated'),
    },
    scripting: { executeScript: async (opts) => { calls.scripts.push(opts); return [{ result: undefined }]; } },
    windows: { getCurrent: async () => ({ id: 1 }) },
    permissions: { contains: async () => true },
  };
  const sandbox = { chrome, console, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let loadError = null;
  try {
    vm.runInContext(worker, sandbox, { filename: 'service-worker.js' });
  } catch (error) {
    loadError = error;
  }
  check(`the worker loads with no side panel or omnibox${loadError ? ` (${loadError.message})` : ''}`, !loadError);
  check('the toolbar button is wired to the dock', listeners.actionClicked?.length === 1);
  check('no Chrome host process is started', calls.connectNative === 0 && calls.alarms === 0);

  await listeners.actionClicked?.[0]?.({ id: 7, url: 'https://bu.service-now.com/incident.do' });
  await new Promise((r) => setTimeout(r, 10));
  check('the button injects the dock', calls.scripts.some((s) => s.files?.includes('content/dock.js')));
  check('and toggles it', calls.scripts.some((s) => s.args?.[0] === 'toggle'));

  const send = (message) => new Promise((resolveReply) => {
    listeners.onMessage[0](message, {}, resolveReply);
  });
  const handoff = await send({ type: 'TG_HANDOFF', payload: { text: 'An answer', title: 'INC1', wake: true } });
  check('a handoff goes to the app extension', calls.native[0]?.message?.op === 'handoff' && calls.native[0]?.app === 'com.brianmatute.TerrierGPTMenu');
  check('wake rides along', calls.native[0]?.message?.wake === true);
  check('the reply comes back to the panel', handoff?.ok === true);
  const catalog = await send({ type: 'TG_CATALOG' });
  check('the catalog comes from the app extension', catalog?.ok && catalog.catalog.actions[0].id === 'triage');

  // ------------------------------------------------------------------- dock
  const dock = readFileSync(join(OUT, 'content/dock.js'), 'utf8');
  check('the dock loads the panel page in dock mode', dock.includes("sidepanel/sidepanel.html?dock=1"));
  check('the dock only listens to its own frame', dock.includes('event.source !== frame.contentWindow'));
  check('the dock hangs off <html>, not <body>', dock.includes('document.documentElement.append(host)'));
  const panel = readFileSync(join(OUT, 'sidepanel/sidepanel.js'), 'utf8');
  check('the panel can close the dock', panel.includes("tg: 'dock-close'"));
  const picker = readFileSync(join(OUT, 'content/picker.js'), 'utf8');
  check('Pick ignores the docked panel', picker.includes('#__terriergpt_dock__'));
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failing.` : '\nAll Safari tests passed.');
process.exit(failures ? 1 : 0);
