#!/usr/bin/env node
/**
 * Tests for the Safari build on iOS: a manifest without context menus or
 * keyboard commands, a worker that still loads without those APIs, a popup as
 * the toolbar button, and TG_SEND_TO_APP handing a ServiceNow ticket to
 * TerrierGPT for iPhone's app extension.
 *
 *     node tools/test-safari-ios.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = mkdtempSync(join(tmpdir(), 'tg-safari-ios-'));

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'}    ${name}`);
  if (!ok) failures += 1;
};

try {
  execFileSync(process.execPath, [join(ROOT, 'tools/build.mjs'), 'safari-ios', '--out', OUT], { stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const worker = readFileSync(join(OUT, 'service-worker.js'), 'utf8');

  // --------------------------------------------------------------- manifest
  for (const key of ['side_panel', 'omnibox', 'commands', 'key', 'minimum_chrome_version']) {
    check(`manifest drops ${key}`, !(key in manifest));
  }
  check('no context menus or side panel', !manifest.permissions.includes('contextMenus') && !manifest.permissions.includes('sidePanel'));
  check('native messaging stays', manifest.permissions.includes('nativeMessaging'));
  check('the button opens the popup', manifest.action.default_popup === 'popup/popup.html');
  for (const file of ['popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'lib/messages.js', 'content/dock.js']) {
    check(`ships ${file}`, existsSync(join(OUT, file)));
  }
  check('the worker knows it is the iOS copy', worker.includes("globalThis.TG_TARGET = 'safari-ios';"));

  // ----------------------------------------------------------------- worker
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] ??= []).push(fn); } });
  const calls = { native: [] };
  const store = () => {
    const data = {};
    return {
      get: async (k) => (typeof k === 'string' ? { [k]: data[k] } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, data[x]])) : { ...k, ...data }),
      set: async (o) => Object.assign(data, o),
      remove: async (k) => { delete data[k]; },
      onChanged: on('storage'),
    };
  };
  const ticketFrame = {
    url: 'https://bu.service-now.com/incident.do?sys_id=abc',
    host: 'bu.service-now.com',
    title: 'INC0012345 | Incident',
    selection: '',
    ticket: { number: 'INC0012345', shortDescription: 'Printer offline', state: 'In Progress', description: 'Paper jam light.' },
  };
  // No contextMenus and no commands, as on iOS.
  const chrome = {
    runtime: {
      onInstalled: on('onInstalled'), onStartup: on('onStartup'), onMessage: on('onMessage'),
      connectNative: () => { throw new Error('no host'); },
      sendNativeMessage: async (app, message) => {
        calls.native.push({ app, message });
        return { ok: true };
      },
    },
    storage: { session: store(), sync: store(), local: store() },
    action: { onClicked: on('actionClicked'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: () => {}, onAlarm: on('alarm') },
    tabs: {
      query: async () => [{ id: 7, url: ticketFrame.url, windowId: 1 }],
      onUpdated: on('tabsUpdated'), onActivated: on('tabsActivated'),
    },
    scripting: { executeScript: async () => [{ result: ticketFrame }] },
    windows: { getCurrent: async () => ({ id: 1 }) },
    permissions: { contains: async () => true },
  };
  const sandbox = { chrome, console, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let loadError = null;
  try {
    vm.runInContext(worker, sandbox, { filename: 'service-worker.js' });
    await listeners.onInstalled?.[0]?.();
  } catch (error) {
    loadError = error;
  }
  check(`the worker loads without context menus or commands${loadError ? ` (${loadError.message})` : ''}`, !loadError);

  const send = (message) => new Promise((resolveReply) => {
    listeners.onMessage[0](message, {}, resolveReply);
  });
  const reply = await send({ type: 'TG_SEND_TO_APP', payload: { mode: 'page' } });
  const sent = calls.native[0];
  check('the ticket goes to the app extension', reply?.ok === true && sent?.message?.op === 'capture');
  check('as a ticket with its number', sent?.message?.kind === 'ticket' && sent?.message?.ticketNumber === 'INC0012345');
  check('titled by its short description', sent?.message?.title === 'Printer offline');
  check('with the formatted ticket body', /Number: INC0012345/.test(sent?.message?.body || '') && /Description:\nPaper jam light\./.test(sent?.message?.body || ''));
  check('addressed to the iPhone app', sent?.app === 'edu.bu.TerrierGPT');

  ticketFrame.selection = 'Paper jam light';
  await send({ type: 'TG_SEND_TO_APP', payload: { mode: 'selection' } });
  check('a selection goes as a selection', calls.native[1]?.message?.kind === 'selection' && calls.native[1]?.message?.body === 'Paper jam light');

  // ------------------------------------------------------------------ popup
  const popup = readFileSync(join(OUT, 'popup/popup.js'), 'utf8');
  check('the popup sends through the worker', popup.includes("type: 'TG_SEND_TO_APP'"));
  check('the popup never opens the app on its own', !/location\.href\s*=|window\.open\(/.test(popup));
  const html = readFileSync(join(OUT, 'popup/popup.html'), 'utf8');
  check('Open TerrierGPT is a link the user taps', html.includes('href="terriergpt://capture"'));
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failing.` : '\nAll Safari iOS tests passed.');
process.exit(failures ? 1 : 0);
