#!/usr/bin/env node
/**
 * Element picker labels. The picker runs in the page, so this loads the same
 * functions in a sandbox and checks the names a ServiceNow field and a plain
 * block get.
 *
 *     node tools/test-pick.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(ROOT, 'content/picker.js'), 'utf8');
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { fieldName, labelFor, textFor } = sandbox.TGPick;

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'}    ${name}`);
  if (!ok) failures += 1;
};

check('a classic field id becomes its label', fieldName('incident.short_description') === 'Short description');
check('a display field id uses the field, not the table', fieldName('sys_display.incident.caller_id') === 'Caller id');
check('a readonly number field is Number', fieldName('sys_readonly.incident.number') === 'Number');
check('work notes keep both words', fieldName('incident.work_notes') === 'Work notes');
check('an extra prefix is not a field id', fieldName('label.incident.short_description') === '');
check('a plain id is not a field', fieldName('short_description') === '');

check(
  'the field name wins over the visible label',
  labelFor({ id: 'incident.description', ariaLabel: 'Something else', text: 'body' }) === 'Description',
);
check(
  'an aria label is used when there is no field',
  labelFor({ id: '', ariaLabel: 'Work notes', text: 'hello' }) === 'Work notes',
);
check(
  'a long block is named from its first line',
  labelFor({ id: '', text: 'The printer on the third floor of Kilachand is jammed again today' }).endsWith('…'),
);
check('an empty block falls back to its tag', labelFor({ id: '', tag: 'DIV', text: '' }) === 'div');

const value = textFor({ value: 'the typed value', text: 'the label' });
check('a control uses its value', value.text === 'the typed value' && value.truncated === false);
check('an empty snapshot has no text', textFor({ value: '', text: '   ' }).text === '');
const long = textFor({ text: 'x'.repeat(9000) });
check('a long block is capped', long.truncated === true && long.text.length === 8000);
check('nbsp is a normal space', textFor({ text: 'a\u00a0b' }).text === 'a b');

const worker = readFileSync(join(ROOT, 'service-worker.js'), 'utf8');
check('the picker is injected from the service worker', worker.includes("files: ['content/picker.js']"));
check('pick mode can be turned off', worker.includes('__tgPicker?.disarm()'));

console.log(failures ? `\n${failures} failing.` : '\nAll pick tests passed.');
process.exit(failures ? 1 : 0);
