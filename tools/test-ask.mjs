#!/usr/bin/env node
/**
 * Tests for how the panel waits on an ask (lib/ask-wait.js): whichever of the
 * direct reply, the stored result, Stop, or silence comes first ends the wait,
 * and a dropped channel never leaves the panel waiting for good.
 *
 *     node tools/test-ask.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { askTracker, isUsableReply, forAsk, newAskId } = await import(pathToFileURL(join(ROOT, 'lib/ask-wait.js')).href);

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- replies
check('undefined reply (dropped Safari channel) is not usable', !isUsableReply(undefined));
check('null reply is not usable', !isUsableReply(null));
check('empty object is not usable', !isUsableReply({}));
check('ok reply is usable', isUsableReply({ ok: true, text: 'x' }));
check('failure with a reason is usable', isUsableReply({ ok: false, reason: 'signed-out' }));

check('forAsk matches only the same id', forAsk({ id: 'a' }, 'a') && !forAsk({ id: 'b' }, 'a') && !forAsk(null, 'a') && !forAsk({ id: 'a' }, null));
check('ask ids are unique', newAskId() !== newAskId());

// -------------------------------------------------------- the direct reply
{
  const t = askTracker({ idleMs: 1000 });
  t.reply({ ok: true, text: 'direct' });
  const r = await t.promise;
  check('direct reply finishes the wait', r.ok && r.text === 'direct');
}

// ------------------------------- dropped channel, result arrives via storage
{
  const t = askTracker({ idleMs: 1000 });
  check('an undefined reply does not finish', t.reply(undefined) === false && !t.done);
  setTimeout(() => t.settle({ ok: true, text: 'stored' }), 20);
  const r = await t.promise;
  check('stored result finishes after a dropped reply', r.ok && r.text === 'stored');
  check('a late direct reply is ignored once settled', t.reply({ ok: true, text: 'late' }) === false);
}

// --------------------------------------------- silence ends as answer-lost
{
  const t = askTracker({ idleMs: 60 });
  t.text('partial answer');
  const r = await t.promise;
  check('silence ends the wait as answer-lost', r.ok === false && r.reason === 'answer-lost');
  check('a lost ask keeps the partial text', r.partial === 'partial answer');
}

// --------------------------------------------- heartbeats keep it waiting
{
  const t = askTracker({ idleMs: 80 });
  const beat = setInterval(() => t.alive(), 20);
  await sleep(200);
  check('heartbeats keep a long ask waiting', !t.done);
  clearInterval(beat);
  t.settle({ ok: true, text: 'done' });
  check('and it still finishes on the result', (await t.promise).text === 'done');
}

// ------------------------------------------------------- the hard ceiling
{
  const t = askTracker({ idleMs: 1000, maxMs: 60 });
  const beat = setInterval(() => t.alive(), 10);
  const r = await t.promise;
  clearInterval(beat);
  check('the ceiling ends even a chatty ask', r.reason === 'generation-timeout');
}

// --------------------------------------------------------------- stop
{
  const t = askTracker({ idleMs: 1000 });
  t.stop();
  const r = await t.promise;
  check('Stop frees the panel at once', r.reason === 'generation-stopped');
}

// ---------------------------------------- wiring between the three sides
const composer = readFileSync(join(ROOT, 'content/composer.js'), 'utf8');
const worker = readFileSync(join(ROOT, 'service-worker.js'), 'utf8');
const panel = readFileSync(join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
check('the tab reports its result as a fresh message', composer.includes("report('TG_ASK_RESULT'"));
check('the tab sends heartbeats', composer.includes("report('TG_ASK_ALIVE'"));
check('the tab does not watch only <main>', !composer.includes("document.querySelector('main') || document.body"));
check('the tab answers a collect', composer.includes("'TG_ASK_COLLECT'"));
for (const type of ['TG_ASK_RESULT', 'TG_ASK_ALIVE', 'TG_ASK_COLLECT']) {
  check(`the worker handles ${type}`, worker.includes(`case '${type}'`));
}
check('the worker passes the ask id to the tab', /TG_ASK_AND_WAIT[\s\S]{0,120}askId/.test(worker));
check('the panel sends an ask id', /type: 'TG_ASK', payload: \{[^}]*askId/.test(panel));
check('the panel listens for stored results', panel.includes('changes.askResult'));
check('docked panels only take asks for their own tab', panel.includes('!isMine(DOCKED ? { tabId: target.tabId } : target)'));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ask-wait checks passed');
