#!/usr/bin/env node
/**
 * The native host and the pinned extension id.
 *
 * The host is the Python program the menu app installs. This runs it against
 * a temporary support folder, never the real handoff directory.
 *
 *     node tools/test-bridge.mjs
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MENU = join(ROOT, '../../Xcode/TerrierGPTMenu');
const HOST = join(MENU, 'MyApp/NativeHost/terriergpt-host.py');
const SWIFT = join(MENU, 'Groups/Automation/CompanionBridge.swift');

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'}    ${name}`);
  if (!ok) failures += 1;
};

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const der = Buffer.from(manifest.key, 'base64');
const hex = createHash('sha256').update(der).digest().subarray(0, 16).toString('hex');
const alphabet = 'abcdefghijklmnop';
const extensionID = [...hex].map((nibble) => alphabet[Number.parseInt(nibble, 16)]).join('');
const swift = readFileSync(SWIFT, 'utf8');

check('the manifest key pins the companion id', extensionID === 'bdppgjcngcpkplhgoaokgbjmifpilaek');
check('the menu allows that same extension id', swift.includes(extensionID));
check('the host name matches on both sides', swift.includes('com.brianmatute.terriergpt.companion') && manifest.permissions.includes('nativeMessaging'));
check('version is 0.5.0', manifest.version === '0.5.0');
check('Chrome, Edge, Brave, Vivaldi, and Arc are registered', ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Vivaldi', 'Arc'].every((name) => swift.includes(name)));

const worker = readFileSync(join(ROOT, 'service-worker.js'), 'utf8');
check('asking still does not put the prompt in the URL', !worker.includes('promptURL'));
check('a handoff is a native message, not a navigation', worker.includes("op: 'handoff'") && worker.includes('connectNative'));
const recipesRoot = join(ROOT, '../../Xcode/CTSRecipes');
const writer = readFileSync(join(recipesRoot, 'CTSRecipes/Engine/BrowserCatalog.swift'), 'utf8');
const recipeModel = readFileSync(join(recipesRoot, 'CTSRecipes/Engine/Recipe.swift'), 'utf8');
check('CTS Recipes writes browser-actions.json', writer.includes('browser-actions.json') && writer.includes('{{CTS_ANALYST_NAME}}'));
check('the recipe model keeps surfaces and page_match', recipeModel.includes('surfaces') && recipeModel.includes('pageMatch') && recipeModel.includes('browserActions'));

const dir = mkdtempSync(join(tmpdir(), 'tg-host-'));
const log = join(dir, 'open.log');
const recorder = join(dir, 'record-open.sh');
writeFileSync(recorder, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$TERRIERGPT_OPEN_LOG"\n');
chmodSync(recorder, 0o755);
writeFileSync(log, '');

const child = spawn('/usr/bin/python3', [HOST], {
  env: {
    ...process.env,
    TERRIERGPT_SUPPORT: dir,
    TERRIERGPT_BROWSER: 'Google Chrome',
    TERRIERGPT_OPEN_BIN: recorder,
    TERRIERGPT_OPEN_LOG: log,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

let buffer = Buffer.alloc(0);
const waiters = [];

function pump() {
  while (waiters.length && buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;
    const body = buffer.subarray(4, 4 + length).toString('utf8');
    buffer = buffer.subarray(4 + length);
    waiters.shift()(JSON.parse(body));
  }
}

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});

function nextMessage(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the host')), ms);
    waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
    pump();
  });
}

function send(message) {
  const raw = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(raw.length, 0);
  child.stdin.write(Buffer.concat([header, raw]));
}

const SECRET = 'SECRET_TICKET_BODY_9f3a';

try {
  send({ op: 'hello', id: 'hello-1' });
  const hello = await nextMessage(2000);
  check('the host answers hello', hello.op === 'hello' && hello.ok === true);

  mkdirSync(join(dir, 'browser-requests'), { recursive: true });
  const stale = {
    id: 'safari-request-0001',
    op: 'read-page',
    browser: 'Safari',
    at: Date.now(),
  };
  writeFileSync(join(dir, 'browser-requests/request.json'), JSON.stringify(stale));
  await new Promise((resolve) => setTimeout(resolve, 500));
  send({ op: 'hello', id: 'hello-2' });
  const stillHello = await nextMessage(2000);
  check('a request for another browser is left alone', stillHello.op === 'hello');
  check('the other browser request is still on disk', existsSync(join(dir, 'browser-requests/request.json')));

  const readID = '11111111-1111-4111-8111-111111111111';
  writeFileSync(join(dir, 'browser-requests/request.json'), JSON.stringify({
    id: readID,
    op: 'read-page',
    browser: 'Google Chrome',
    at: Date.now(),
  }));
  const asked = await nextMessage(2000);
  check('the host asks the extension to read the page', asked.op === 'read-page' && asked.id === readID);
  send({
    op: 'read-page',
    id: readID,
    ok: true,
    title: 'INC0099',
    body: 'ticket body',
    selection: '',
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const page = JSON.parse(readFileSync(join(dir, `browser-requests/response-${readID}.json`), 'utf8'));
  check('the page read is written for the menu', page.ok === true && page.body === 'ticket body');

  send({
    op: 'handoff',
    id: 'handoff-1',
    text: `${SECRET}\n\n\`\`\`json\n{"contract":"example-one","version":1}\n\`\`\`\n\n\`\`\`json\n{"contract":"kb-gap-verdict","version":1}\n\`\`\``,
    title: 'INC0099',
    url: 'https://bu.service-now.com/incident.do',
    wake: false,
  });
  const saved = await nextMessage(2000);
  check('a handoff is saved', saved.ok === true && saved.contract === 'kb-gap-verdict');
  const envelope = JSON.parse(readFileSync(saved.path, 'utf8'));
  const latest = JSON.parse(readFileSync(join(dir, 'handoffs/latest.json'), 'utf8'));
  check('the envelope is a handoff', envelope.handoff === 1 && envelope.payload.contract === 'kb-gap-verdict');
  check('latest.json matches the envelope', latest.id === envelope.id);
  check('the prose stays on the envelope', envelope.text.includes(SECRET));
  check('an unchecked validation is recorded', envelope.validation.status === 'unchecked');

  send({
    op: 'handoff',
    id: 'handoff-2',
    text: SECRET,
    title: 'INC0099',
    url: 'https://bu.service-now.com/incident.do',
    wake: true,
  });
  const woken = await nextMessage(2000);
  check('a plain answer uses terriergpt-answer', woken.ok === true && woken.contract === 'terriergpt-answer');
  const inbox = JSON.parse(readFileSync(woken.inbox, 'utf8'));
  check('the inbox copy counts a hop', inbox.hops === 0 && inbox.payload.answer === SECRET && inbox.payload.generated_by === 'app-fallback');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const opened = readFileSync(log, 'utf8');
  check('CTS Recipes is woken with the inbox link', opened.includes('ctsrecipes://inbox'));
  check('the menu is told a file was saved', opened.includes('terriergpt://companion?'));
  check('the answer body is not put in the URL', !opened.includes(SECRET));

  send({ op: 'handoff', id: 'handoff-empty', text: '   ' });
  const empty = await nextMessage(2000);
  check('an empty handoff is refused', empty.ok === false && empty.reason === 'empty');

  send({
    op: 'handoff',
    id: 'handoff-unsafe',
    text: '```json\n{"contract":"../../etc","version":1}\n```',
    title: 'Nope',
  });
  const unsafe = await nextMessage(2000);
  check('an unsafe contract name falls back', unsafe.ok === true && unsafe.contract === 'terriergpt-answer');

  const CATALOG = 'CATALOG_PROMPT_7c2e';
  writeFileSync(join(dir, 'browser-actions.json'), JSON.stringify({
    version: 1,
    actions: [{ id: 'triage', label: 'Triage', prompt: CATALOG, primary: true, order: 0, page_match: 'ticket', recipe: 'triage-and-reply' }],
  }));
  send({ op: 'catalog', id: 'catalog-1' });
  const served = await nextMessage(2000);
  check('the host serves the catalog', served.ok === true && served.op === 'catalog' && served.catalog.actions[0].prompt === CATALOG);
  check('the catalog prompt is not logged', !stderr.includes(CATALOG));
  check('the catalog prompt is not put in a URL', !readFileSync(log, 'utf8').includes(CATALOG));

  writeFileSync(join(dir, 'browser-actions.json'), '{"actions":"nope"}');
  send({ op: 'catalog', id: 'catalog-bad' });
  const bad = await nextMessage(2000);
  check('a catalog without an action list is refused', bad.ok === false && bad.reason === 'no-catalog');

  rmSync(join(dir, 'browser-actions.json'));
  send({ op: 'catalog', id: 'catalog-missing' });
  const missing = await nextMessage(2000);
  check('a missing catalog is no-catalog', missing.ok === false && missing.reason === 'no-catalog');
} catch (error) {
  check(error.message, false);
  if (stderr) console.log(stderr);
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failing.` : '\nAll bridge tests passed.');
process.exit(failures ? 1 : 0);
