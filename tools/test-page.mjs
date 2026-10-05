#!/usr/bin/env node
/**
 * Tests for the page the panel actually sends: ServiceNow field formatting,
 * which frame wins, the ticket actions, and answer rendering.
 *
 *     node tools/test-page.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { formatTicket, pickExtraction, presentPage, isServiceNowHost } = await load('lib/extract.js');
const { TRIAGE_PROMPT, TICKET_ACTIONS, PAGE_ACTIONS, actionsFor, primaryAction, usesCatalog } = await load('lib/actions.js');
const { renderMarkdown } = await load('lib/markdown.js');
const { DEFAULT_INSTANCE } = await load('lib/config.js');

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

const ticket = {
  number: 'INC0012345',
  state: 'In Progress',
  caller: 'Ada Lovelace',
  shortDescription: 'Lab printer offline',
  description: 'The printer in 610 does not wake.',
  assignmentGroup: 'Client Technology Services',
  priority: '3 - Moderate',
  activity: 'Work notes\nChecked the queue.',
  impact: '',
  location: '',
};

const formatted = formatTicket(ticket, 40000);
check('ticket body leads with the number', formatted.body.startsWith('Number: INC0012345'));
check('ticket body includes the description', formatted.body.includes('Description:\nThe printer in 610 does not wake.'));
check('ticket body includes the activity', formatted.body.includes('Activity:\nWork notes'));
check('empty ticket fields are left out', !formatted.body.includes('Impact:') && !formatted.body.includes('Location:'));
check('a short cap truncates and says so', formatTicket(ticket, 40).truncated === true && formatTicket(ticket, 40).body.length === 40);
check('no ticket formats to nothing', formatTicket(null).body === '');

const chromeFrame = {
  title: 'ServiceNow',
  url: 'https://bu.service-now.com/nav_to.do',
  host: 'bu.service-now.com',
  selection: '',
  pageText: 'Incidents\n'.repeat(80),
  truncated: false,
  ticket: null,
};
const formFrame = {
  title: 'INC0012345 | ServiceNow',
  url: 'https://bu.service-now.com/incident.do?sys_id=abc',
  host: 'bu.service-now.com',
  selection: '',
  pageText: 'Save',
  truncated: false,
  ticket,
};
const picked = pickExtraction([chromeFrame, formFrame]);
check('the form frame wins over a longer navigator shell', picked?.ticket?.number === 'INC0012345');

const selected = pickExtraction([
  { ...formFrame, selection: '' },
  { ...chromeFrame, selection: 'the queue is stuck' },
]);
check('a selection in another frame is kept when the form has none', selected.selection === 'the queue is stuck');
check('the form selection wins when it has one', pickExtraction([{ ...formFrame, selection: 'printer' }, chromeFrame]).selection === 'printer');
check('no frames is nothing', pickExtraction([]) === null);

const page = presentPage(picked, 40000);
check('a ticket page is kind ticket', page.kind === 'ticket');
check('the prompt body is the formatted ticket, not the shell', page.body.includes('Number: INC0012345') && !page.body.includes('Incidents'));
check('the card title is the short description', page.title === 'Lab printer offline');
check('service-now hosts are recognized', page.serviceNow === true && isServiceNowHost('bu.service-now.com'));
check('other hosts are not ServiceNow', isServiceNowHost('terriergpt.bu.edu') === false);

const article = presentPage({
  title: 'Add/Drop',
  url: 'https://www.bu.edu/reg',
  host: 'www.bu.edu',
  selection: '',
  pageText: 'Drop without a W.',
  truncated: false,
  ticket: null,
});
check('a normal page stays a page', article.kind === 'page' && article.body === 'Drop without a W.');

check('ticket actions are the four shelf jobs', TICKET_ACTIONS.map((action) => action.id).join() === 'triage,reply,work-note,summarize');
check('triage is the primary ticket action', primaryAction(page).id === 'triage');
check('other pages get summarize and explain', actionsFor(article).map((action) => action.id).join() === 'summarize-page,explain-page');
check('a ticket page does not get the generic page actions', actionsFor(page) === TICKET_ACTIONS);

const recipePath = join(ROOT, '../../Xcode/CTSRecipes/Packs/cts-ai-working-group/triage-and-reply.json');
check('the triage recipe is on disk', existsSync(recipePath));
if (existsSync(recipePath)) {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  check('triage uses the CTS Recipes prompt unchanged', TRIAGE_PROMPT === recipe.prompt);
  check('triage opts into the chrome ticket catalog', Array.isArray(recipe.surfaces) && recipe.surfaces.includes('chrome') && recipe.page_match === 'ticket');
  check('the triage button uses the recipe prompt', recipe.browser?.id === 'triage' && recipe.browser.primary === true && recipe.browser.prompt === undefined);
  const byId = Object.fromEntries((recipe.browser_actions || []).map((action) => [action.id, action.prompt]));
  for (const action of TICKET_ACTIONS.filter((item) => item.id !== 'triage')) {
    check(`${action.id} matches the recipe`, action.prompt === byId[action.id]);
  }
  check('the shared pack does not name an analyst', !JSON.stringify(recipe).includes('Brian'));
  check('the reply closes with the profile placeholder', byId.reply.includes('{{CTS_ANALYST_NAME}}'));
}

const packDir = join(ROOT, '../../Xcode/CTSRecipes/Packs/cts-ai-working-group');
const opted = readdirSync(packDir)
  .filter((name) => name.endsWith('.json'))
  .filter((name) => {
    const body = JSON.parse(readFileSync(join(packDir, name), 'utf8'));
    return Array.isArray(body.surfaces) && body.surfaces.includes('chrome');
  });
check('only triage opts into chrome', opted.join() === 'triage-and-reply.json');

const catalog = {
  actions: [
    { id: 'triage', label: 'Triage', prompt: 'FROM CATALOG', primary: true, order: 2, page_match: 'ticket', recipe: 'triage-and-reply' },
    { id: 'reply', label: 'Reply', prompt: 'REPLY CATALOG', order: 1, page_match: 'ticket' },
    { id: 'blank', label: 'Blank', prompt: '   ', page_match: 'ticket' },
    { id: 'read', label: 'Read', prompt: 'PAGE', primary: true, order: 0, page_match: 'page' },
    { id: 'either', label: 'Either', prompt: 'ANY', order: 5, page_match: 'any' },
  ],
};
check('a catalog prompt wins over the fallback', actionsFor(page, catalog).map((action) => action.id).join() === 'reply,triage,either');
check('an empty catalog prompt is skipped', !actionsFor(page, catalog).some((action) => action.id === 'blank'));
check('the catalog primary is the flagged action', primaryAction(page, catalog).id === 'triage');
check('a page catalog replaces summarize and explain', actionsFor(article, catalog).map((action) => action.id).join() === 'read,either');
check('the panel can tell a catalog list from the fallback', usesCatalog(page, catalog) === true && usesCatalog(page, null) === false);
check('a catalog with no ticket rows falls back', actionsFor(page, { actions: [{ id: 'read', label: 'Read', prompt: 'PAGE', page_match: 'page' }] }) === TICKET_ACTIONS);
check('no catalog keeps the built-in page actions', actionsFor(article) === PAGE_ACTIONS);

const html = renderMarkdown('**Keep** it.\n\n- one\n- two\n\n```\n<script>alert(1)</script>\n```');
check('bold becomes strong', html.includes('<strong>Keep</strong>'));
check('a list is a list', html.includes('<ul>') && html.includes('<li>one</li>'));
check('model HTML is escaped', html.includes('&lt;script&gt;') && !html.includes('<script>'));
check('an empty answer renders nothing', renderMarkdown('  ') === '');

check('prod is the default instance', DEFAULT_INSTANCE === 'prod');

const worker = readFileSync(join(ROOT, 'service-worker.js'), 'utf8');
check('the send path does not put prompts in the URL', !worker.includes('promptURL'));
check('asking does not clear captured context', !worker.includes('clearCaptures'));
const panel = readFileSync(join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
check('the clipboard button imports addCapture', panel.includes('addCapture'));
check('a queued ask uses the same catalog as the buttons', panel.includes('primaryAction(currentPage, catalog)'));
check('the panel asks the host for the catalog', panel.includes("type: 'TG_CATALOG'") && worker.includes("op: 'catalog'") && worker.includes('browserCatalog'));

console.log(failures ? `\n${failures} failing.` : '\nAll page tests passed.');
process.exit(failures ? 1 : 0);
