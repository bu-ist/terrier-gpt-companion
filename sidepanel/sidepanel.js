/**
 * The side panel stays on the page you are reading.
 * A ticket is summarized in the card, the Tickets-shelf actions ask TerrierGPT
 * in a background tab, and the answer is rendered here.
 */

import { INSTANCES, getSettings, setSettings } from '../lib/config.js';
import { SOURCE, makeCapture, loadCaptures, saveCaptures, addCapture } from '../lib/prompt.js';
import { describe } from '../lib/messages.js';
import { parseAgentId, loadAgents, addAgent, agentsFor, searchAgents } from '../lib/agents.js';
import { actionsFor, primaryAction, usesCatalog } from '../lib/actions.js';
import { renderMarkdown } from '../lib/markdown.js';

const SELECTION_ID = 'auto-selection';
/** Safari docks this page inside the tab (content/dock.js) instead of a side panel. */
const DOCKED = new URLSearchParams(location.search).has('dock');
/** Answers kept per page, so switching tabs and coming back does not lose one. */
const ANSWERS_KEY = 'answers';
const ANSWERS_KEPT = 20;
/** One accent per action, in order, like the Mac app's dock. The primary stays scarlet. */
const ACTION_TINTS = ['azure', 'violet', 'jade', 'surf', 'ember', 'gold'];
const AVATAR_HUES = ['#8f5cfa', '#338aff', '#21cc85', '#ff7833', '#2ecced', '#cc0a21', '#ffbd38'];

const el = {
  prod: document.getElementById('instance-prod'),
  test: document.getElementById('instance-test'),
  testPill: document.getElementById('test-pill'),
  agentChip: document.getElementById('agent-chip'),
  agentChipName: document.getElementById('agent-chip-name'),
  settings: document.getElementById('settings'),
  gearMenu: document.getElementById('gear-menu'),
  sessionBadge: document.getElementById('session-badge'),
  sessionText: document.getElementById('session-text'),
  sessionDetail: document.getElementById('session-detail'),
  signIn: document.getElementById('sign-in'),
  openSettings: document.getElementById('open-settings'),
  menu: document.getElementById('menu'),
  agentCount: document.getElementById('agent-count'),
  agentSearch: document.getElementById('agent-search'),
  agentList: document.getElementById('agent-list'),
  agentSync: document.getElementById('agent-sync'),
  agentAdd: document.getElementById('agent-add'),
  agentForm: document.getElementById('agent-form'),
  agentLink: document.getElementById('agent-link'),
  agentName: document.getElementById('agent-name'),
  agentCancel: document.getElementById('agent-cancel'),
  card: document.getElementById('page-card'),
  kicker: document.getElementById('page-kicker'),
  title: document.getElementById('page-title'),
  meta: document.getElementById('page-meta'),
  grant: document.getElementById('grant'),
  grantText: document.getElementById('grant-text'),
  grantBtn: document.getElementById('grant-btn'),
  actions: document.getElementById('actions'),
  catalogNote: document.getElementById('catalog-note'),
  pick: document.getElementById('pick'),
  pickHint: document.getElementById('pick-hint'),
  context: document.getElementById('context'),
  clear: document.getElementById('clear'),
  capsules: document.getElementById('capsules'),
  answerLabel: document.getElementById('answer-label'),
  responseAgent: document.getElementById('response-agent'),
  spinner: document.getElementById('response-spinner'),
  stop: document.getElementById('stop-generation'),
  dismiss: document.getElementById('dismiss-response'),
  responseBody: document.getElementById('response-body'),
  placeholder: document.getElementById('placeholder'),
  placeholderText: document.getElementById('placeholder-text'),
  answerFoot: document.getElementById('answer-foot'),
  copy: document.getElementById('copy-response'),
  openTab: document.getElementById('open-tab-response'),
  sendMenu: document.getElementById('send-menu'),
  sendRecipes: document.getElementById('send-recipes'),
  form: document.getElementById('ask-form'),
  instruction: document.getElementById('instruction'),
  clipboard: document.getElementById('clipboard'),
  send: document.getElementById('send'),
  status: document.getElementById('status'),
};

let currentPage = null;
let catalog = null;
let catalogState = 'fallback';
let currentOrigin = null;
let shownURL = '';
let answerRaw = '';
let asking = false;
let picking = false;
let handing = false;
let stopped = false;
let refreshSeq = 0;
let refreshTimer = null;
let holdRefresh = 0;
let consumeLock = null;
let currentInstance = 'prod';
let selectedAgent = null;

function say(message, tone = 'info') {
  el.status.textContent = message || '';
  el.status.dataset.tone = tone;
}

async function ask(message) {
  return chrome.runtime.sendMessage(message);
}

function canRead() {
  return Boolean(currentPage?.body?.trim());
}

async function enabledExtras() {
  const captures = await loadCaptures();
  return captures.filter((capture) => capture.enabled && capture.body?.trim());
}

// --------------------------------------------------------------------- render

function renderCard(info) {
  const page = info?.page;
  const tab = info?.tab;
  const granted = Boolean(info?.ok || info?.granted);
  currentOrigin = null;
  try {
    if (tab?.url && /^https?:/i.test(tab.url)) currentOrigin = new URL(tab.url).origin;
  } catch {}

  if (info?.reason === 'unsupported-page') {
    currentPage = null;
    el.card.classList.remove('ticket');
    el.kicker.textContent = 'Page';
    el.title.textContent = 'This page can’t be read';
    el.meta.textContent = 'Extensions can’t read this kind of page.';
    el.grant.hidden = true;
    return;
  }

  const title = page?.title || tab?.title || 'This page';
  const host = page?.host || tab?.host || '';
  el.title.textContent = title;
  el.card.classList.toggle('ticket', page?.kind === 'ticket');

  if (!info?.ok) {
    currentPage = null;
    el.kicker.textContent = host || 'Page';
    el.meta.textContent = host;
    el.grant.hidden = granted || info?.reason !== 'no-access';
    if (!el.grant.hidden) {
      el.grantText.textContent = `Allow ${host || 'this site'} so the panel can read it. One site at a time. Revoke it in Settings.`;
    }
    if (info?.reason && info.reason !== 'no-access') say(describe(info.reason), 'error');
    return;
  }

  currentPage = page;
  el.grant.hidden = true;
  if (page.kind === 'ticket') {
    el.kicker.textContent = page.ticket?.number || 'Ticket';
    const bits = [page.ticket?.state, page.ticket?.caller, page.ticket?.priority].filter(Boolean);
    bits.push(`${page.body.length.toLocaleString()} characters`);
    if (page.truncated) bits.push('Truncated');
    el.meta.textContent = bits.join(' · ');
  } else {
    el.kicker.textContent = host || 'Page';
    const bits = [];
    if (page.serviceNow) bits.push('Form fields were not on this page. Using the visible text.');
    bits.push(`${page.body.length.toLocaleString()} characters`);
    if (page.truncated) bits.push('Truncated');
    el.meta.textContent = bits.join(' · ');
  }
}

function renderActions() {
  const actions = actionsFor(currentPage, catalog);
  const note = catalogNote();
  el.catalogNote.hidden = !note;
  el.catalogNote.textContent = note;
  const ready = canRead() || el.capsules.childElementCount > 0;
  el.actions.replaceChildren();
  let tint = 0;
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary
      ? 'pill pill-primary'
      : `pill glass tint-${ACTION_TINTS[tint++ % ACTION_TINTS.length]}`;
    button.textContent = action.label;
    button.disabled = asking || !ready;
    button.addEventListener('click', () => {
      showMenu(false);
      void runAsk(action.prompt, { followUp: false, label: action.label });
    });
    el.actions.append(button);
  }
  el.send.disabled = asking;
  el.pick.disabled = asking || handing;
  el.clipboard.disabled = asking;
  el.sendMenu.disabled = handing;
  el.sendRecipes.disabled = handing;
}

function catalogNote() {
  if (usesCatalog(currentPage, catalog)) return 'From CTS Recipes';
  if (currentPage?.kind !== 'ticket') return '';
  if (catalogState === 'bridge') return 'Open TerrierGPT Menu once so these can load from CTS Recipes.';
  return 'Open CTS Recipes once to load these from the Tickets shelf.';
}

function renderCapsules(captures) {
  el.capsules.replaceChildren();
  el.context.hidden = captures.length === 0;
  for (const capture of captures) {
    const meta = SOURCE[capture.source] ?? { label: capture.source, tint: 'azure' };
    const row = document.createElement('div');
    row.className = `capsule glass tint-${meta.tint === 'blue' ? 'azure' : meta.tint === 'emerald' ? 'jade' : meta.tint === 'cyan' ? 'surf' : meta.tint}`;
    row.dataset.enabled = String(capture.enabled);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.title = capture.enabled ? 'Included in the prompt. Click to leave it out.' : 'Left out of the prompt. Click to include it.';
    toggle.setAttribute('aria-pressed', String(capture.enabled));
    toggle.setAttribute('aria-label', `${meta.label}: include in the prompt`);
    const dot = document.createElement('span');
    dot.className = 'dot';
    toggle.append(dot);
    toggle.addEventListener('click', () => void setEnabled(capture.id, !capture.enabled));

    const label = document.createElement('span');
    label.className = 'capsule-label';
    const chars = `${capture.body.length.toLocaleString()} characters`;
    const name = capture.title && capture.title !== meta.label ? `${meta.label} · ${capture.title}` : meta.label;
    label.textContent = name;
    label.title = `${name} · ${chars}\n\n${capture.body.slice(0, 240)}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.append(icon('i-close'));
    remove.addEventListener('click', () => void removeCapture(capture.id));

    row.append(toggle, label, remove);
    el.capsules.append(row);
  }
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

async function refreshCapsules() {
  renderCapsules(await loadCaptures());
  renderActions();
}

async function setEnabled(id, enabled) {
  const captures = await loadCaptures();
  const found = captures.find((capture) => capture.id === id);
  if (found) found.enabled = enabled;
  await saveCaptures(captures);
  renderCapsules(captures);
}

async function removeCapture(id) {
  const captures = (await loadCaptures()).filter((capture) => capture.id !== id);
  await saveCaptures(captures);
  renderCapsules(captures);
}

async function syncSelection(page) {
  const captures = await loadCaptures();
  const rest = captures.filter((capture) => capture.id !== SELECTION_ID);
  const text = page?.selection?.trim() || '';
  if (!text || rest.some((capture) => capture.source === 'selection' && capture.body === text)) {
    if (rest.length !== captures.length) await saveCaptures(rest);
    return;
  }
  const previous = captures.find((capture) => capture.id === SELECTION_ID);
  await saveCaptures([
    {
      id: SELECTION_ID,
      source: 'selection',
      title: 'Selection',
      detail: page.host,
      url: page.url,
      body: text,
      enabled: previous?.body === text ? previous.enabled : true,
      partial: null,
      capturedAt: Date.now(),
    },
    ...rest,
  ]);
}

async function forceSelection(text, url) {
  const body = String(text || '').trim();
  if (!body) return;
  const rest = (await loadCaptures()).filter((capture) => capture.id !== SELECTION_ID && capture.body !== body);
  await saveCaptures([
    {
      id: SELECTION_ID,
      source: 'selection',
      title: 'Selection',
      detail: currentPage?.host || '',
      url: url || currentPage?.url || '',
      body,
      enabled: true,
      partial: null,
      capturedAt: Date.now(),
    },
    ...rest,
  ]);
}

function showAnswer(raw, { streaming = false } = {}) {
  answerRaw = raw || '';
  el.responseBody.classList.toggle('streaming', streaming && Boolean(answerRaw));
  if (!answerRaw) {
    el.responseBody.replaceChildren(el.placeholder);
    el.placeholder.hidden = false;
    el.placeholder.classList.toggle('busy', asking);
    el.placeholderText.textContent = asking
      ? 'Asking TerrierGPT in a background tab…'
      : 'Pick an action above. The answer stays beside this page.';
    el.answerFoot.hidden = true;
    el.dismiss.hidden = true;
    return;
  }
  el.placeholder.hidden = true;
  el.responseBody.innerHTML = renderMarkdown(answerRaw);
  if (streaming) el.responseBody.scrollTop = el.responseBody.scrollHeight;
  el.answerFoot.hidden = streaming;
  el.dismiss.hidden = streaming;
}

function clearAnswer() {
  answerRaw = '';
  showAnswer('');
  el.answerLabel.textContent = 'Answer';
  el.responseAgent.hidden = true;
}

async function loadAnswers() {
  const { [ANSWERS_KEY]: answers = {} } = await chrome.storage.session.get(ANSWERS_KEY);
  return answers;
}

/** Remembers the answer for the page it was asked about. */
async function rememberAnswer(url, entry) {
  if (!url) return;
  const answers = await loadAnswers();
  if (entry) answers[url] = { ...entry, at: Date.now() };
  else delete answers[url];
  const kept = Object.entries(answers)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, ANSWERS_KEPT);
  await chrome.storage.session.set({ [ANSWERS_KEY]: Object.fromEntries(kept) });
}

async function restoreAnswer(url) {
  const saved = url ? (await loadAnswers())[url] : null;
  if (!saved?.text) {
    clearAnswer();
    return;
  }
  showAnswer(saved.text);
  el.answerLabel.textContent = saved.label || 'Answer';
  el.responseAgent.hidden = !saved.agent;
  el.responseAgent.textContent = saved.agent || '';
}

// -------------------------------------------------------------------- agents

function hueFor(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

function agentRow({ id, name, description, selected }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'agent-row';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(selected));
  row.dataset.id = id;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  if (id) {
    avatar.style.setProperty('--hue', hueFor(id));
    avatar.textContent = (name.trim()[0] || 'A').toUpperCase();
  } else {
    avatar.style.setProperty('--hue', '#cc0a21');
    avatar.append(icon('i-sparkles'));
  }

  const text = document.createElement('span');
  text.className = 'agent-text';
  const title = document.createElement('span');
  title.className = 'agent-title';
  title.textContent = name;
  text.append(title);
  if (description) {
    const desc = document.createElement('span');
    desc.className = 'agent-desc';
    desc.textContent = description;
    text.append(desc);
    row.title = `${name}\n${description}`;
  }

  const tick = icon('i-check');
  tick.classList.add('tick');
  row.append(avatar, text, tick);
  row.addEventListener('click', () => void chooseAgent(id || null));
  return row;
}

async function renderAgents(selectedId) {
  const origin = INSTANCES[currentInstance]?.origin;
  const agents = agentsFor(await loadAgents(), origin);
  const settings = await getSettings();
  const wanted = selectedId === undefined ? settings.agentId : selectedId;
  selectedAgent = agents.find((agent) => agent.id === wanted) ?? null;
  if (wanted && !selectedAgent) await setSettings({ agentId: null });

  el.agentCount.textContent = agents.length ? `${agents.length}` : '';
  const query = el.agentSearch.value;
  const shown = searchAgents(agents, query);
  el.agentList.replaceChildren();
  if (!query.trim()) {
    el.agentList.append(agentRow({
      id: '',
      name: 'No agent',
      description: 'Whatever model TerrierGPT is set to.',
      selected: !selectedAgent,
    }));
  }
  for (const agent of shown) {
    el.agentList.append(agentRow({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      selected: agent.id === selectedAgent?.id,
    }));
  }
  if (!agents.length || !shown.length) {
    const empty = document.createElement('p');
    empty.className = 'agent-empty';
    empty.textContent = agents.length
      ? `No agent matches “${query.trim()}”.`
      : 'No agents yet. Sync them from TerrierGPT, or add one from its link.';
    el.agentList.append(empty);
  }

  el.agentChipName.hidden = !selectedAgent;
  el.agentChipName.textContent = selectedAgent?.name ?? '';
  el.agentChip.title = selectedAgent ? `Agent: ${selectedAgent.name}` : 'Choose an agent';
  el.agentChip.setAttribute('aria-label', el.agentChip.title);
}

async function chooseAgent(id) {
  await setSettings({ agentId: id });
  await renderAgents(id);
  showMenu(false);
  say(selectedAgent ? `Asking ${selectedAgent.name}.` : 'Using no agent.', 'ok');
}

async function refreshSession() {
  const instance = INSTANCES[currentInstance];
  let state = null;
  try {
    state = await ask({ type: 'TG_SESSION' });
  } catch {}
  const signedIn = Boolean(state?.signedIn);
  const known = Boolean(state?.known);
  el.sessionBadge.dataset.state = signedIn ? 'in' : known ? 'out' : 'unknown';
  el.sessionText.textContent = signedIn ? 'Signed in' : known ? 'Signed out' : 'Not checked';
  el.sessionDetail.textContent = signedIn
    ? `${instance.label} is signed in. Sign in again if asking says otherwise.`
    : known
      ? `${instance.label} is signed out. Sign in, then ask again.`
      : `No ${instance.label} tab is open, so the session could not be checked.`;
}

function showGear(open) {
  el.gearMenu.hidden = !open;
  el.settings.setAttribute('aria-expanded', String(open));
  if (open) {
    showMenu(false);
    void refreshSession();
  }
}

function showMenu(open) {
  if (open) showGear(false);
  el.menu.hidden = !open;
  el.agentChip.setAttribute('aria-expanded', String(open));
  if (!open) {
    el.agentForm.hidden = true;
    el.agentAdd.setAttribute('aria-expanded', 'false');
    if (el.agentSearch.value) {
      el.agentSearch.value = '';
      void renderAgents();
    }
  } else {
    requestAnimationFrame(() => el.agentSearch.focus());
  }
}

function applyInstance(id) {
  const instance = INSTANCES[id] ? id : 'prod';
  currentInstance = instance;
  el.prod.setAttribute('aria-pressed', String(instance === 'prod'));
  el.test.setAttribute('aria-pressed', String(instance === 'test'));
  el.testPill.hidden = instance !== 'test';
  el.prod.title = INSTANCES.prod.origin;
  el.test.title = INSTANCES.test.origin;
}

// ----------------------------------------------------------------- active tab

function scheduleRefresh() {
  if (holdRefresh) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshPage(), 120);
}

async function refreshPage() {
  const seq = ++refreshSeq;
  const info = await ask({ type: 'TG_READ_ACTIVE_TAB' });
  if (seq !== refreshSeq) return;

  const nextURL = info?.page?.url || info?.tab?.url || '';
  if (nextURL && shownURL !== nextURL && !asking) await restoreAnswer(nextURL);
  if (nextURL) shownURL = nextURL;

  renderCard(info);
  if (info?.ok) await syncSelection(info.page);
  else await syncSelection(null);
  await refreshCapsules();
  renderActions();
}

// ----------------------------------------------------------------------- ask

async function buildCaptures(followUp) {
  const settings = await getSettings();
  const list = [];
  if (currentPage?.body?.trim()) {
    list.push(makeCapture({
      source: 'page',
      title: currentPage.ticket?.number || currentPage.title,
      detail: currentPage.host,
      url: currentPage.url,
      body: currentPage.body,
      partial: currentPage.truncated
        ? `Truncated at ${Number(settings.maxPageChars).toLocaleString()} characters`
        : null,
    }));
  }
  list.push(...(await enabledExtras()));
  if (followUp && answerRaw.trim()) {
    list.push(makeCapture({
      source: 'answer',
      title: 'Previous answer',
      body: answerRaw.slice(0, 20000),
    }));
  }
  return list;
}

async function runAsk(instruction, { followUp = false, label = 'Answer' } = {}) {
  const text = String(instruction || '').trim();
  const captures = await buildCaptures(followUp);
  if (!text && !captures.length) {
    say('Allow the page, or add some text, first.', 'error');
    return false;
  }

  if (picking) await stopPick(false);
  asking = true;
  stopped = false;
  renderActions();
  el.answerLabel.textContent = label || 'Answer';
  const agentLabel = selectedAgent?.name ?? '';
  const askedURL = currentPage?.url || shownURL;
  el.responseAgent.hidden = !agentLabel;
  el.responseAgent.textContent = agentLabel;
  el.spinner.hidden = false;
  el.stop.hidden = false;
  showAnswer('');
  say('Asking TerrierGPT…');

  try {
    const result = await ask({
      type: 'TG_ASK',
      payload: { instruction: text, captures },
    });
    if (stopped) {
      say('Stopped.');
      return false;
    }
    if (!result?.ok) {
      const message = describe(result?.reason);
      say(message, 'error');
      if (!answerRaw) showAnswer(message);
      if (result?.reason === 'signed-out') showGear(true);
      return false;
    }
    showAnswer(result.text || answerRaw || '');
    if (result.text) {
      say('Answer received.', 'ok');
      await rememberAnswer(askedURL, { text: result.text, label: label || 'Answer', agent: agentLabel });
    } else {
      say('TerrierGPT returned no text.', 'error');
    }
    return Boolean(result.text);
  } catch (error) {
    if (answerRaw) say('The connection dropped. The text above is what arrived.', 'error');
    else {
      say(String(error), 'error');
      showAnswer(String(error));
    }
    return false;
  } finally {
    asking = false;
    el.spinner.hidden = true;
    el.stop.hidden = true;
    if (answerRaw) showAnswer(answerRaw);
    else showAnswer('');
    renderActions();
  }
}

async function consumePending() {
  if (consumeLock) return consumeLock;
  consumeLock = (async () => {
    await catalogReady;
    const { pendingAsk } = await chrome.storage.session.get('pendingAsk');
    if (!pendingAsk?.id) return;
    await chrome.storage.session.remove('pendingAsk');
    holdRefresh += 1;
    try {
      await refreshPage();
      if (pendingAsk.selection) await forceSelection(pendingAsk.selection, pendingAsk.url);
      await refreshCapsules();
      const chosen = primaryAction(currentPage, catalog);
      const instruction = String(pendingAsk.instruction || '').trim() || chosen.prompt;
      const label = pendingAsk.label || chosen.label;
      await runAsk(instruction, { followUp: false, label });
    } finally {
      holdRefresh -= 1;
    }
  })().finally(() => {
    consumeLock = null;
  });
  return consumeLock;
}

// -------------------------------------------------------------------- events

el.settings.addEventListener('click', () => showGear(el.gearMenu.hidden));
if (DOCKED) {
  document.body.classList.add('docked');
  const close = document.getElementById('dock-close');
  close.hidden = false;
  close.addEventListener('click', () => parent.postMessage({ tg: 'dock-close' }, '*'));
}
el.openSettings.addEventListener('click', () => {
  showGear(false);
  chrome.runtime.openOptionsPage();
});
el.signIn.addEventListener('click', async () => {
  showGear(false);
  const result = await ask({ type: 'TG_SIGN_IN' });
  say(result?.ok
    ? `BU Login opened in a new tab. Come back here once ${INSTANCES[currentInstance].label} loads.`
    : describe(result?.reason), result?.ok ? 'ok' : 'error');
});
el.agentChip.addEventListener('click', () => showMenu(el.menu.hidden));

el.prod.addEventListener('click', async () => {
  await setSettings({ instance: 'prod' });
  applyInstance('prod');
  await renderAgents();
  say('Using TerrierGPT.');
});
el.test.addEventListener('click', async () => {
  await setSettings({ instance: 'test' });
  applyInstance('test');
  await renderAgents();
  say('Using TerrierGPT Test.');
});

el.agentSearch.addEventListener('input', () => void renderAgents());
el.agentSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const first = el.agentList.querySelector('.agent-row');
  if (first) first.click();
});

el.agentSync.addEventListener('click', async () => {
  say('Syncing agents…');
  el.agentSync.disabled = true;
  try {
    const result = await ask({ type: 'TG_SYNC_AGENTS' });
    if (result?.ok) {
      await renderAgents();
      if (result.source === 'api') {
        say(result.discoveredCount
          ? `Found ${result.discoveredCount} agent${result.discoveredCount === 1 ? '' : 's'} in your TerrierGPT account.`
          : 'Your TerrierGPT account has no agents yet.', 'ok');
      } else {
        say(result.discoveredCount
          ? `Found ${result.discoveredCount} agent${result.discoveredCount === 1 ? '' : 's'} on the open page. The account list did not answer.`
          : describe('agents-api'), result.discoveredCount ? 'ok' : 'error');
      }
    } else {
      say(describe(result?.reason), 'error');
      if (result?.reason === 'signed-out') showGear(true);
    }
  } catch (error) {
    say(String(error), 'error');
  } finally {
    el.agentSync.disabled = false;
  }
});

el.agentAdd.addEventListener('click', () => {
  el.agentForm.hidden = !el.agentForm.hidden;
  el.agentAdd.setAttribute('aria-expanded', String(!el.agentForm.hidden));
  if (!el.agentForm.hidden) el.agentLink.focus();
});
el.agentCancel.addEventListener('click', () => {
  el.agentForm.hidden = true;
});
el.agentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = parseAgentId(el.agentLink.value);
  if (!id) {
    say('That link has no agent_id.', 'error');
    return;
  }
  await addAgent({ id, name: el.agentName.value, origin: INSTANCES[currentInstance].origin });
  el.agentLink.value = '';
  el.agentName.value = '';
  await chooseAgent(id);
  say('Agent saved.', 'ok');
});

el.grantBtn.addEventListener('click', async () => {
  if (!currentOrigin) return;
  try {
    const granted = await chrome.permissions.request({ origins: [`${currentOrigin}/*`] });
    if (!granted) {
      say('Access declined.', 'error');
      return;
    }
    await refreshPage();
  } catch (error) {
    say(String(error), 'error');
  }
});

el.clear.addEventListener('click', async () => {
  await saveCaptures([]);
  await refreshCapsules();
});

el.clipboard.addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText())?.trim();
    if (!text) {
      say(describe('clipboard-empty'), 'error');
      return;
    }
    const firstLine = text.split('\n')[0].trim();
    const title = firstLine.length > 40 ? `${firstLine.slice(0, 38)}…` : firstLine || 'Clipboard';
    await addCapture(makeCapture({
      source: 'clipboard',
      title,
      detail: 'Clipboard',
      body: text,
    }));
    await refreshCapsules();
    say('Clipboard added.', 'ok');
  } catch {
    say(describe('clipboard-error'), 'error');
  }
});

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const instruction = el.instruction.value.trim();
  if (!instruction) {
    say('Write a question, or use one of the actions above.', 'error');
    return;
  }
  void runAsk(instruction, { followUp: Boolean(answerRaw), label: 'Ask' }).then((ok) => {
    if (ok) el.instruction.value = '';
  });
});

el.copy.addEventListener('click', async () => {
  if (!answerRaw) return;
  try {
    await navigator.clipboard.writeText(answerRaw);
  } catch {
    say('Could not write to the clipboard.', 'error');
    return;
  }
  el.copy.querySelector('use')?.setAttribute('href', '#i-check');
  say('Answer copied.', 'ok');
  setTimeout(() => el.copy.querySelector('use')?.setAttribute('href', '#i-copy'), 1600);
});

el.openTab.addEventListener('click', () => void ask({ type: 'TG_FOCUS_TAB' }));

el.pick.addEventListener('click', () => void togglePick());

el.sendMenu.addEventListener('click', () => void sendHandoff(false));

el.sendRecipes.addEventListener('click', () => void sendHandoff(true));

el.dismiss.addEventListener('click', () => {
  clearAnswer();
  void rememberAnswer(shownURL, null);
});

el.stop.addEventListener('click', async () => {
  stopped = true;
  await ask({ type: 'TG_STOP_GENERATION' });
  el.spinner.hidden = true;
  el.stop.hidden = true;
  say('Stopped.');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (picking) {
    void stopPick(true);
    return;
  }
  if (!el.menu.hidden) showMenu(false);
  if (!el.gearMenu.hidden) showGear(false);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TG_PICKED') void addPicked(message.payload);
  else if (message?.type === 'TG_PICK_CANCELLED') {
    if (picking) say('Pick cancelled.');
    setPicking(false);
  } else if (message?.type === 'TG_PICK_EMPTY') {
    say('That element has no text.');
  }
});

function setPicking(on) {
  picking = on;
  el.pick.title = on ? 'Cancel picking (Esc)' : 'Pick an element on the page';
  el.pick.setAttribute('aria-label', el.pick.title);
  el.pick.setAttribute('aria-pressed', String(on));
  el.pickHint.hidden = !on;
}

async function stopPick(announce) {
  setPicking(false);
  await ask({ type: 'TG_PICK_STOP' });
  if (announce) say('Pick cancelled.');
}

async function togglePick() {
  if (picking) {
    await stopPick(true);
    return;
  }
  const result = await ask({ type: 'TG_PICK' });
  if (!result?.ok) {
    say(describe(result?.reason || 'no-access'), 'error');
    return;
  }
  setPicking(true);
  say('Click an element on the page. Esc cancels.');
}

async function addPicked(payload) {
  setPicking(false);
  void ask({ type: 'TG_PICK_STOP' });
  const text = String(payload?.text || '').trim();
  if (!text) {
    say('That element has no text.');
    return;
  }
  const label = String(payload?.label || 'Selection').trim() || 'Selection';
  await addCapture(makeCapture({
    source: 'selection',
    title: label,
    detail: 'Picked',
    url: payload?.url || currentPage?.url || null,
    body: text,
    partial: payload?.truncated ? 'Truncated' : null,
  }));
  await refreshCapsules();
  say(`Added ${label}.`, 'ok');
}

async function sendHandoff(wake) {
  const text = String(answerRaw || '').trim();
  if (!text) {
    say('There is no answer to send yet.', 'error');
    return;
  }
  handing = true;
  renderActions();
  say(wake ? 'Sending to CTS Recipes…' : 'Saving to TerrierGPT Menu…');
  const result = await ask({
    type: 'TG_HANDOFF',
    payload: {
      wake,
      text,
      title: currentPage?.ticket?.number || currentPage?.title || '',
      url: currentPage?.url || '',
    },
  });
  handing = false;
  renderActions();
  if (!result?.ok) {
    say(describe(result?.reason || 'bridge-failed'), 'error');
    return;
  }
  const shortened = result.truncated ? ' The text was shortened to fit the handoff.' : '';
  say(wake ? `Sent to the CTS Recipes inbox.${shortened}` : `Saved to TerrierGPT Menu.${shortened}`, 'ok');
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.captures) void refreshCapsules();
  if (changes.reread) scheduleRefresh();
  if (changes.pendingAsk?.newValue) void consumePending();
  if (asking && changes.liveAnswer?.newValue?.text) showAnswer(changes.liveAnswer.newValue.text, { streaming: true });
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.agents) void renderAgents();
});

chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.instance?.newValue) {
    applyInstance(changes.instance.newValue);
    void renderAgents();
  }
  if (changes.agentId && !changes.instance) void renderAgents();
});

// Clicking anywhere outside the agent sheet closes it.
document.addEventListener('pointerdown', (event) => {
  if (!el.menu.hidden && !el.menu.contains(event.target) && !el.agentChip.contains(event.target)) showMenu(false);
  if (!el.gearMenu.hidden && !el.gearMenu.contains(event.target) && !el.settings.contains(event.target)) showGear(false);
});

chrome.tabs.onActivated.addListener(() => scheduleRefresh());
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (tab.active && changeInfo.url && picking) void stopPick(false);
  if (tab.active && (changeInfo.status === 'complete' || changeInfo.url)) scheduleRefresh();
});
chrome.permissions.onAdded.addListener(() => scheduleRefresh());
chrome.permissions.onRemoved.addListener(() => scheduleRefresh());

async function refreshCatalog() {
  try {
    const result = await ask({ type: 'TG_CATALOG' });
    if (result?.ok && Array.isArray(result.catalog?.actions)) {
      catalog = result.catalog;
      catalogState = 'live';
    } else {
      catalog = null;
      catalogState = result?.reason === 'bridge-missing' || result?.reason === 'bridge-failed' ? 'bridge' : 'fallback';
    }
  } catch {
    catalog = null;
    catalogState = 'fallback';
  }
  renderActions();
}

const catalogReady = refreshCatalog();

async function init() {
  const settings = await getSettings();
  applyInstance(settings.instance);
  await renderAgents(settings.agentId);
  await catalogReady;
  await refreshPage();
  await consumePending();
}

void init();
