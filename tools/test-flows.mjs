#!/usr/bin/env node
/**
 * Comprehensive tests for end-to-end companion flows:
 * - Clipboard context extraction and prompt composition
 * - Response state handling and formatting
 * - Agent resolution and URL synthesis
 * - Failure code mapping
 *
 *     node tools/test-flows.mjs
 */

import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.crypto ??= webcrypto;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { makeCapture, compose, totalChars, SOURCE } = await load('lib/prompt.js');
const { parseAgentId, chatURL, promptURL, mergeDiscoveredAgents } = await load('lib/agents.js');
const { describe } = await load('lib/messages.js');
const { INSTANCES, DEFAULTS } = await load('lib/config.js');

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

// 1. Pasteboard / Clipboard capture flow
check('clipboard source is registered with tint', SOURCE.clipboard && SOURCE.clipboard.tint === 'emerald');

const clip1 = makeCapture({
  source: 'clipboard',
  title: 'Error Log from Terminal',
  detail: 'Clipboard',
  body: 'Uncaught TypeError: Cannot read properties of undefined',
});

check('clipboard capture creates valid UUID', typeof clip1.id === 'string' && clip1.id.length > 20);
check('clipboard capture is enabled by default', clip1.enabled === true);

const composedWithClip = compose('Diagnose this issue', [clip1]);
check('prompt leads with instruction', composedWithClip.startsWith('Diagnose this issue\n\n'));
check('prompt wraps clipboard context block', composedWithClip.includes('--- Clipboard: Error Log from Terminal ---'));
check('prompt body contains clipboard content', composedWithClip.includes('Uncaught TypeError: Cannot read properties of undefined'));

// 2. Multi-source combination: page + selection + clipboard
const pageCap = makeCapture({ source: 'page', title: 'BU Course Search', url: 'https://bu.edu/courses', body: 'CS 506: Data Science' });
const multiComposed = compose('Compare these', [pageCap, clip1]);
check('combines multiple sources in order', multiComposed.indexOf('BU Course Search') < multiComposed.indexOf('Error Log'));
check('totalChars sums enabled sources accurately', totalChars([pageCap, clip1]) === (pageCap.body.length + clip1.body.length));

// 3. Agent routing flow
const testOrigin = INSTANCES.test.origin;
const agentId = 'agent_bu_syllabus_helper';

check('parseAgentId handles deep links', parseAgentId(`${testOrigin}/c/new?agent_id=${agentId}`) === agentId);
check('parseAgentId handles /agents/ path', parseAgentId(`${testOrigin}/agents/${agentId}`) === agentId);

const deepChat = chatURL(testOrigin, agentId);
check('chatURL targets new chat with agent_id query param', deepChat === `${testOrigin}/c/new?agent_id=${agentId}`);

const autoPromptUrl = promptURL(testOrigin, { agentId, text: 'Hello', autoSend: true });
check('promptURL carries agent_id and submit=true', autoPromptUrl.includes(`agent_id=${agentId}`) && autoPromptUrl.includes('submit=true'));

// 4. Discovered agents syncing
let store = { agents: [] };
globalThis.chrome = {
  storage: {
    sync: {
      get: async (k) => ({ [k]: store[k] ?? [] }),
      set: async (obj) => { Object.assign(store, obj); },
    },
  },
};

await mergeDiscoveredAgents([
  { id: 'agent_course_adviser', name: 'Course Adviser', description: 'Degree roadmap assistant' },
  { id: 'agent_writing_tutor', name: 'Writing Tutor', description: 'Essay feedback assistant' },
]);

check('merged 2 agents into sync storage', store.agents.length === 2);
check('agent descriptions stored', store.agents[0].description === 'Degree roadmap assistant');

// Merge again with duplicate and new agent
await mergeDiscoveredAgents([
  { id: 'agent_course_adviser', name: 'Course Adviser' },
  { id: 'agent_financial_aid', name: 'BU Aid Bot' },
]);
check('no duplicates on subsequent syncs', store.agents.length === 3);

// 5. Failure code coverage
const failureCodes = [
  'unsupported-page',
  'no-access',
  'no-content',
  'empty-selection',
  'empty-page',
  'empty-prompt',
  'composer-not-found',
  'no-content-script',
  'busy',
  'signed-out',
  'send-unavailable',
  'clipboard-empty',
  'clipboard-error',
  'no-agents-found',
  'generation-timeout',
  'generation-stopped',
  'generation-failed',
  'bridge-missing',
  'bridge-failed',
];

for (const code of failureCodes) {
  check(`failure message defined for '${code}'`, describe(code) !== 'Something went wrong.' && describe(code).length > 0);
}

console.log(failures ? `\n${failures} failing.` : '\nAll integration flow tests passed.');
process.exit(failures ? 1 : 0);
