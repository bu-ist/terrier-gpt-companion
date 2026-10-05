#!/usr/bin/env node
/**
 * Tests for reading an agent out of whatever the user pasted.
 *
 *     node tools/test-agents.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { parseAgentId, chatURL, shortLabel, promptURL, MAX_PROMPT_URL, mergeDiscoveredAgents } = await import(
  pathToFileURL(join(ROOT, 'lib/agents.js')).href
);

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

const ID = 'agent_Xy9-tK_2Qa';
const ORIGIN = 'https://test.terriergpt-nonprod.bu.edu';

check('the link LibreChat copies', parseAgentId(`${ORIGIN}/c/new?agent_id=${ID}`) === ID);
check('the marketplace link', parseAgentId(`${ORIGIN}/agents?agent_id=${ID}&q=x`) === ID);
check('a bare id', parseAgentId(ID) === ID);
check('surrounding whitespace', parseAgentId(`  ${ID}  `) === ID);
check('the production origin too', parseAgentId(`https://terriergpt.bu.edu/c/new?agent_id=${ID}`) === ID);

check('a link with no agent_id', parseAgentId(`${ORIGIN}/c/new`) === null);
check('a conversation link', parseAgentId(`${ORIGIN}/c/abc123`) === null);
check('an id without the prefix', parseAgentId('Xy9-tK_2Qa') === null);
check('an assistant id', parseAgentId('asst_abc123') === null);
check('empty input', parseAgentId('') === null);
check('null input', parseAgentId(null) === null);
check('plain prose', parseAgentId('the KB writer agent') === null);
check('a bare prefix', parseAgentId('agent_') === null);

check('round trips through chatURL', parseAgentId(chatURL(ORIGIN, ID)) === ID);
check('chatURL uses the deep-link shape', chatURL(ORIGIN, ID) === `${ORIGIN}/c/new?agent_id=${ID}`);
check('a short id is shown whole', shortLabel('agent_kb') === 'Agent kb');
check('a ten-character id still fits', shortLabel(ID) === 'Agent Xy9-tK_2Qa');
check('a longer id is elided', shortLabel('agent_abcdefghijklmnop') === 'Agent abcdefgh…');

// ---------------------------------------------------------------- promptURL

const short = promptURL(ORIGIN, { text: 'Summarize this' });
check('prompt rides in the query string', short.includes('prompt=Summarize+this'));
check('no agent means no agent_id', !short.includes('agent_id'));
check('no auto-send means no submit flag', !short.includes('submit'));
check('it targets a new conversation', short.startsWith(`${ORIGIN}/c/new?`));

const full = promptURL(ORIGIN, { agentId: ID, text: 'a & b = c?', autoSend: true });
check('the agent rides along', full.includes(`agent_id=${ID}`));
check('auto-send is asked for explicitly', full.includes('submit=true'));
check('reserved characters are encoded', full.includes('prompt=a+%26+b+%3D+c%3F'));
check('the agent survives a round trip', parseAgentId(full) === ID);

check('the cap leaves room under the measured 13k floor', MAX_PROMPT_URL <= 8000);
const big = promptURL(ORIGIN, { text: 'x'.repeat(MAX_PROMPT_URL) });
check('an oversized prompt is over the cap, so it falls back', big.length > MAX_PROMPT_URL);

check('the path-based agents URL', parseAgentId(`${ORIGIN}/agents/agent_Xy9-tK_2Qa`) === 'agent_Xy9-tK_2Qa');
check('the dashboard agents URL', parseAgentId(`${ORIGIN}/d/agents/agent_Xy9-tK_2Qa`) === 'agent_Xy9-tK_2Qa');

// -------------------------------------------------------- mergeDiscoveredAgents
let syncStore = { agents: [{ id: 'agent_existing', name: 'Existing Agent' }] };
globalThis.chrome = {
  storage: {
    sync: {
      get: async (key) => ({ [key]: syncStore[key] ?? [] }),
      set: async (obj) => { Object.assign(syncStore, obj); },
    },
  },
};

const merged = await mergeDiscoveredAgents([
  { id: 'agent_existing', name: 'Ignored Overwrite' },
  { id: 'agent_new', name: 'BU Assistant', description: 'Helpful BU bot' },
  { id: 'invalid_id', name: 'Invalid' },
]);

check('merge retains existing custom name', syncStore.agents.find((a) => a.id === 'agent_existing')?.name === 'Existing Agent');
check('merge adds new discovered agent', syncStore.agents.some((a) => a.id === 'agent_new' && a.name === 'BU Assistant'));
check('merge rejects invalid agent ids', !syncStore.agents.some((a) => a.id === 'invalid_id'));

console.log(failures ? `\n${failures} failing.` : '\nAll agent tests passed.');
process.exit(failures ? 1 : 0);
