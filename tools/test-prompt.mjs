#!/usr/bin/env node
/**
 * Tests for prompt composition — the one piece of logic with no browser in it,
 * and the one that has to stay byte-compatible with `PromptComposer` in the
 * TerrierGPT macOS app so a prompt from either side reads the same.
 *
 *     node tools/test-prompt.mjs
 */
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.crypto ??= webcrypto;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { makeCapture, compose, totalChars, DEFAULT_INSTRUCTION } = await load('lib/prompt.js');
const { describe } = await load('lib/messages.js');

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

const page = makeCapture({
  source: 'page',
  title: 'Add/Drop Deadlines',
  detail: 'bu.edu',
  url: 'https://www.bu.edu/reg/deadlines',
  body: 'Drop without a W by 20 Sep.',
});
const selection = makeCapture({ source: 'selection', title: 'Policy', body: 'Late fee is $50.' });

check('an instruction with no context is passed through untouched', compose('Summarize', []) === 'Summarize');
check('a blank instruction falls back to the default', compose('   ', []) === DEFAULT_INSTRUCTION);
check('the fallback still leads when there is context', compose('', [page]).startsWith(DEFAULT_INSTRUCTION));

const out = compose('Draft a KB article', [page, selection]);
check('the instruction comes first', out.startsWith('Draft a KB article\n\n'));
check('a capture gets a labelled header', out.includes('--- Page: Add/Drop Deadlines ---'));
check('a capture with a URL gets a source line', out.includes('Source: https://www.bu.edu/reg/deadlines'));
check('a capture without a URL gets no source line', !out.includes('Source: undefined'));
check('captures keep the order they were added in', out.indexOf('Add/Drop') < out.indexOf('Policy'));
check('every body is carried through', out.includes('Drop without a W by 20 Sep.') && out.includes('Late fee is $50.'));

selection.enabled = false;
check('a switched-off capture is left out', !compose('X', [page, selection]).includes('Late fee'));
check('the character count follows the switches', totalChars([page, selection]) === page.body.length);

const blank = makeCapture({ source: 'page', title: 'Blank', body: '   ' });
check('a whitespace-only capture is dropped', !compose('X', [blank]).includes('Blank'));

const clipboard = makeCapture({ source: 'clipboard', title: 'Code snippet', body: 'console.log("hello");' });
check('a clipboard capture gets labelled correctly', compose('Explain', [clipboard]).includes('--- Clipboard: Code snippet ---'));
check('clipboard capture includes body', compose('Explain', [clipboard]).includes('console.log("hello");'));

check('captures get distinct ids', makeCapture({ source: 'page' }).id !== makeCapture({ source: 'page' }).id);
check('a known failure code has copy', describe('busy').includes('still answering'));
check('clipboard failure code has copy', describe('clipboard-empty').includes('empty'));
check('agent failure code has copy', describe('no-agents-found').includes('No agents'));
check('an unknown failure code still says something', describe('nonsense') === 'Something went wrong.');

console.log(failures ? `\n${failures} failing.` : '\nAll prompt tests passed.');
process.exit(failures ? 1 : 0);
