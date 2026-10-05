/**
 * The side panel stays on the page you are reading.
 * A ticket is summarized in the card, the Tickets-shelf actions ask TerrierGPT
 * in a background tab, and the answer is rendered here.
 */

import { INSTANCES, getSettings, setSettings } from '../lib/config.js';
import { SOURCE, makeCapture, loadCaptures, saveCaptures, addCapture } from '../lib/prompt.js';
import { describe } from '../lib/messages.js';
import { parseAgentId, loadAgents, addAgent } from '../lib/agents.js';
import { actionsFor, primaryAction, usesCatalog } from '../lib/actions.js';
import { renderMarkdown } from '../lib/markdown.js';

const SELECTION_ID = 'auto-selection';

const el = {
  prod: document.getElementById('instance-prod'),
  test: document.getElementById('instance-test'),
  testPill: document.getElementById('test-pill'),
  agentChip: document.getElementById('agent-chip'),
  settings: document.getElementById('settings'),
  menu: document.getElementById('menu'),
  agent: document.getElementById('agent'),
  agentSync: document.getElementById('agent-sync'),
  agentAdd: document.getElementById('agent-add'),
  agentForm: document.getElementById('agent-form'),
  agentLink: document.getElementById('agent-link'),
  agentName: document.getElementById('agent-name'),
  agentCancel: document.getElementById('agent-cancel'),
  openSettings: document.getElementById('open-settings'),
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
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary ? 'pill pill-primary' : 'pill';
    button.textContent = action.label;
    button.disabled = asking || !ready;
    button.addEventListener('click', () => {
      el.menu.hidden = true;
      el.settings.setAttribute('aria-expanded', 'false');
      void runAsk(action.prompt, { followUp: false, label: action.label });
    });
    el.actions.append(button);
  }
  el.send.disabled = asking;
  el.pick.disabled = asking || handing;
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
    row.className = 'capsule';
    row.dataset.enabled = String(capture.enabled);
    row.style.boxShadow = `inset 2px 0 0 ${tintColor(meta.tint)}`;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = capture.enabled ? '●' : '○';
    toggle.title = capture.enabled ? 'Included in the prompt' : 'Left out of the prompt';
    toggle.addEventListener('click', () => void setEnabled(capture.id, !capture.enabled));

    const label = document.createElement('span');
    label.className = 'capsule-label';
    const chars = `${capture.body.length.toLocaleString()} characters`;
    label.textContent = `${meta.label} · ${chars}`;
    label.title = capture.body.slice(0, 240);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => void removeCapture(capture.id));

    row.append(toggle, label, remove);
    el.capsules.append(row);
  }
}

function tintColor(name) {
  return {
    violet: '#8f5cfa',
    blue: '#338aff',
    cyan: '#2ecced',
    emerald: '#21cc85',
    scarlet: '#cc0a21',
    azure: '#338aff',
  }[name] || '#8c94a6';
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
  if (!answerRaw) {
    el.responseBody.replaceChildren(el.placeholder);
    el.placeholder.hidden = false;
    el.placeholder.textContent = asking ? 'Asking TerrierGPT…' : 'The answer stays on this page.';
    el.answerFoot.hidden = true;
    el.dismiss.hidden = true;
    return;
  }
  el.placeholder.hidden = true;
  el.responseBody.innerHTML = renderMarkdown(answerRaw);
  if (streaming) el.responseBody.scrollTop = el.responseBody.scrollHeight;
  el.answerFoot.hidden = false;
  el.dismiss.hidden = false;
}

function clearAnswer() {
  answerRaw = '';
  showAnswer('');
  el.answerLabel.textContent = 'Answer';
  el.responseAgent.hidden = true;
}

// -------------------------------------------------------------------- agents

async function renderAgents(selectedId) {
  const agents = await loadAgents();
  const settings = await getSettings();
  const wanted = selectedId === undefined ? settings.agentId : selectedId;
  el.agent.replaceChildren();

  const none = document.createElement('option');
  none.value = '';
  none.textContent = agents.length ? 'No agent' : 'No agents yet';
  el.agent.append(none);

  for (const agent of agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = agent.name;
    el.agent.append(option);
  }
  el.agent.value = agents.some((agent) => agent.id === wanted) ? wanted : '';
  if (wanted && el.agent.value !== wanted) await setSettings({ agentId: null });

  const selected = agents.find((agent) => agent.id === el.agent.value);
  el.agentChip.hidden = !selected;
  el.agentChip.textContent = selected ? selected.name : '';
  el.agentChip.title = selected ? selected.name : '';
}

function showMenu(open) {
  el.menu.hidden = !open;
  el.settings.setAttribute('aria-expanded', String(open));
  if (!open) el.agentForm.hidden = true;
}

function applyInstance(id) {
  const instance = INSTANCES[id] ? id : 'prod';
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
  if (shownURL && nextURL && shownURL !== nextURL && !asking) clearAnswer();
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
  const agentLabel = el.agent.selectedOptions[0]?.textContent;
  if (el.agent.value && agentLabel) {
    el.responseAgent.hidden = false;
    el.responseAgent.textContent = agentLabel;
  } else {
    el.responseAgent.hidden = true;
  }
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
      return false;
    }
    showAnswer(result.text || answerRaw || '');
    if (result.text) say('Answer received.');
    else say('TerrierGPT returned no text.', 'error');
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

el.settings.addEventListener('click', () => showMenu(el.menu.hidden));
el.agentChip.addEventListener('click', () => showMenu(true));
el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

el.prod.addEventListener('click', async () => {
  await setSettings({ instance: 'prod' });
  applyInstance('prod');
  say('Using TerrierGPT.');
});
el.test.addEventListener('click', async () => {
  await setSettings({ instance: 'test' });
  applyInstance('test');
  say('Using TerrierGPT Test.');
});

el.agent.addEventListener('change', async () => {
  await setSettings({ agentId: el.agent.value || null });
  await renderAgents(el.agent.value || null);
  say(el.agent.value ? `Using ${el.agent.selectedOptions[0].textContent}.` : 'Using no agent.');
});

el.agentSync.addEventListener('click', async () => {
  say('Syncing agents…');
  el.agentSync.disabled = true;
  try {
    const result = await ask({ type: 'TG_SYNC_AGENTS' });
    if (result?.ok) {
      await renderAgents();
      say(result.count ? `Synced ${result.count} agents.` : 'No agents found in the open TerrierGPT tab.');
    } else {
      say(describe(result?.reason), 'error');
    }
  } catch (error) {
    say(String(error), 'error');
  } finally {
    el.agentSync.disabled = false;
  }
});

el.agentAdd.addEventListener('click', () => {
  el.agentForm.hidden = !el.agentForm.hidden;
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
  await addAgent({ id, name: el.agentName.value });
  await setSettings({ agentId: id });
  await renderAgents(id);
  el.agentForm.hidden = true;
  say('Agent saved.');
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
    say('Clipboard added.');
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
  await navigator.clipboard.writeText(answerRaw);
  const previous = el.copy.textContent;
  el.copy.textContent = 'Copied';
  setTimeout(() => {
    el.copy.textContent = previous;
  }, 1600);
});

el.openTab.addEventListener('click', () => void ask({ type: 'TG_FOCUS_TAB' }));

el.pick.addEventListener('click', () => void togglePick());

el.sendMenu.addEventListener('click', () => void sendHandoff(false));

el.sendRecipes.addEventListener('click', () => void sendHandoff(true));

el.dismiss.addEventListener('click', () => clearAnswer());

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
  showMenu(false);
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
  el.pick.textContent = on ? 'Cancel' : 'Pick';
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
  say(`Added ${label}.`);
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
  say(wake ? `Sent to the CTS Recipes inbox.${shortened}` : `Saved to TerrierGPT Menu.${shortened}`);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.captures) void refreshCapsules();
  if (changes.reread) scheduleRefresh();
  if (changes.pendingAsk?.newValue) void consumePending();
  if (asking && changes.liveAnswer?.newValue?.text) showAnswer(changes.liveAnswer.newValue.text, { streaming: true });
});

chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.agents) void renderAgents();
  if (changes.instance?.newValue) applyInstance(changes.instance.newValue);
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
