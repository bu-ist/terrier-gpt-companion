/**
 * The side panel stays on the page you are reading.
 * A ticket is summarized in the card, the Tickets-shelf actions ask TerrierGPT
 * in a background tab, and the answer is rendered here.
 */

import { INSTANCES, getSettings, setSettings } from '../lib/config.js';
import { SOURCE, makeCapture, loadCaptures as loadScoped, saveCaptures as saveScoped, addCapture as addScoped, capturesKey } from '../lib/prompt.js';
import { scopeKey, inScope } from '../lib/scope.js';
import { describe } from '../lib/messages.js';
import { parseAgentId, loadAgents, addAgent, agentsFor, searchAgents } from '../lib/agents.js';
import { actionsFor, primaryAction, usesCatalog } from '../lib/actions.js';
import { journalForAction, postRequest, postingInstruction, splitNote, NOTE_OPEN, NOTE_CLOSE } from '../lib/journal.js';
import { renderMarkdown } from '../lib/markdown.js';
import { askTracker, newAskId, forAsk, isUsableReply } from '../lib/ask-wait.js';

const SELECTION_ID = 'auto-selection';
/** Safari docks this page inside the tab (content/dock.js) instead of a side panel. */
const DOCKED = new URLSearchParams(location.search).has('dock');
// Safari: the tab this docked panel lives in, so it only answers asks queued for it.
const DOCK_TAB = Number(new URLSearchParams(location.search).get('tab')) || null;

/**
 * The part of the browser this panel belongs to: its own window in Chrome
 * (one side panel per window), its own tab when docked in Safari. Every read,
 * capture, pick, post, and queued ask is about this scope only, so two windows
 * never see or send each other's pages. See lib/scope.js.
 */
let panelScope = null;
let myCapturesKey = capturesKey('');
const scopeReady = (async () => {
  let scope = null;
  if (DOCK_TAB) {
    scope = { tabId: DOCK_TAB };
  } else {
    try {
      const win = await chrome.windows.getCurrent();
      if (Number.isInteger(win?.id)) scope = { windowId: win.id };
    } catch {}
  }
  panelScope = scope;
  myCapturesKey = capturesKey(scopeKey(scope));
  return scope;
})();

/** Whether a tab, tab event, or queued request belongs to this panel. */
function isMine({ tabId, windowId } = {}) {
  return inScope(panelScope, { tabId, windowId });
}

// This panel's own context list. The store is per scope; see lib/prompt.js.
async function loadCaptures() {
  return loadScoped(scopeKey(await scopeReady));
}
async function saveCaptures(captures) {
  return saveScoped(captures, scopeKey(await scopeReady));
}
async function addCapture(capture) {
  return addScoped(capture, scopeKey(await scopeReady));
}
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
  post: document.getElementById('post-journal'),
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
/** The note as it will be posted: split from the answer, then whatever the analyst edited. */
let noteDraft = '';
let noteSource = '';
let answerActionId = '';
let answerTicket = '';
let answerPosted = false;
let postArmed = false;
let postArmedAt = 0;
let posting = false;
let asking = false;
let picking = false;
let handing = false;
let stopped = false;
let currentAsk = null;
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

/** Every message to the worker says which window or tab this panel is for. */
async function ask(message) {
  const scope = await scopeReady;
  return chrome.runtime.sendMessage(scope ? { ...message, scope } : message);
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
      void runAsk(action.prompt, { followUp: false, label: action.label, actionId: action.id });
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

function showAnswer(raw, { streaming = false, note = null } = {}) {
  answerRaw = raw || '';
  el.responseBody.classList.toggle('streaming', streaming && Boolean(answerRaw));
  if (!answerRaw) {
    noteDraft = '';
    noteSource = '';
    el.responseBody.replaceChildren(el.placeholder);
    el.placeholder.hidden = false;
    el.placeholder.classList.toggle('busy', asking);
    el.placeholderText.textContent = asking
      ? 'Asking TerrierGPT in a background tab…'
      : 'Pick an action above. The answer stays beside this page.';
    el.answerFoot.hidden = true;
    el.dismiss.hidden = true;
    el.post.hidden = true;
    return;
  }
  el.placeholder.hidden = true;
  const spec = journalForAction(answerActionId);
  if (spec && !streaming) {
    renderNote(spec, note);
  } else {
    // While it streams, the markers are noise. They are only a hand-off format.
    el.responseBody.innerHTML = renderMarkdown(answerRaw.split(NOTE_OPEN).join('').split(NOTE_CLOSE).join(''));
    noteDraft = '';
    noteSource = '';
  }
  if (streaming) el.responseBody.scrollTop = el.responseBody.scrollHeight;
  el.answerFoot.hidden = streaming;
  el.dismiss.hidden = streaming;
  syncPostButton();
}

/**
 * A Reply or Work note shows two things: the note that will be posted, as
 * plain editable text, and anything TerrierGPT said to the analyst, which is
 * never posted.
 */
function renderNote(spec, saved) {
  const split = splitNote(answerRaw);
  noteDraft = typeof saved === 'string' ? saved : split.note;
  noteSource = split.source;

  const card = document.createElement('section');
  card.className = 'note-card';
  const head = document.createElement('div');
  head.className = 'note-head';
  const kicker = document.createElement('span');
  kicker.className = 'kicker';
  kicker.textContent = spec.clientVisible ? 'Emails the client' : 'Goes on the ticket';
  const hint = document.createElement('span');
  hint.className = 'note-hint';
  hint.textContent = answerPosted ? 'Posted' : 'Exactly as shown. Click to edit.';
  head.append(kicker, hint);

  const text = document.createElement('div');
  text.className = 'note-text';
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-multiline', 'true');
  text.setAttribute('aria-label', spec.clientVisible ? 'Reply to post' : 'Work note to post');
  text.contentEditable = answerPosted ? 'false' : 'plaintext-only';
  text.spellcheck = true;
  text.textContent = noteDraft;
  text.addEventListener('input', () => {
    noteDraft = text.innerText.replace(/\u00a0/g, ' ');
    postArmed = false;
    syncPostButton();
  });
  text.addEventListener('blur', () => void saveNoteEdit());
  card.append(head, text);

  if (noteSource === 'cleaned' && !answerPosted) {
    const check = document.createElement('p');
    check.className = 'note-check';
    check.textContent = 'TerrierGPT did not mark the note, so the companion took out what looked like comments to you. Check it before posting.';
    card.append(check);
  }

  const parts = [card];
  if (split.aside) {
    const aside = document.createElement('details');
    aside.className = 'note-aside';
    const summary = document.createElement('summary');
    summary.textContent = 'From TerrierGPT, not posted';
    const body = document.createElement('div');
    body.className = 'note-aside-body';
    body.innerHTML = renderMarkdown(split.aside);
    aside.append(summary, body);
    parts.push(aside);
  }
  el.responseBody.replaceChildren(...parts);
}

async function saveNoteEdit() {
  const url = shownURL || currentPage?.url || '';
  const saved = url ? (await loadAnswers())[url] : null;
  if (!saved?.text || saved.text !== answerRaw) return;
  await rememberAnswer(url, { ...saved, note: noteDraft });
}

function syncPostButton() {
  const spec = journalForAction(answerActionId);
  if (!spec || !answerRaw.trim() || asking) {
    el.post.hidden = true;
    return;
  }
  el.post.hidden = false;
  el.post.disabled = posting || answerPosted || !noteDraft.trim();
  el.post.textContent = answerPosted
    ? (spec.clientVisible ? 'Reply posted' : 'Work note posted')
    : (postArmed ? spec.confirm : spec.verb);
  el.post.title = spec.clientVisible
    ? 'Posts this reply where the client can read it. ServiceNow emails them, then the form reloads.'
    : 'Posts this as an internal work note, then reloads the form. Unsaved edits on the form are lost.';
}

function clearAnswer() {
  answerRaw = '';
  noteDraft = '';
  answerActionId = '';
  answerTicket = '';
  answerPosted = false;
  postArmed = false;
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
  answerActionId = saved.actionId || '';
  answerTicket = saved.ticketNumber || '';
  answerPosted = saved.posted === true;
  postArmed = false;
  showAnswer(saved.text, { note: typeof saved.note === 'string' ? saved.note : null });
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
  let info = null;
  try {
    info = await ask({ type: 'TG_READ_ACTIVE_TAB' });
  } catch (error) {
    // A worker that is restarting rejects; render "no access" rather than stall init.
    info = { ok: false, reason: 'no-content', detail: String(error) };
  }
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

async function runAsk(instruction, { followUp = false, label = 'Answer', actionId = '' } = {}) {
  const text = String(instruction || '').trim();
  const captures = await buildCaptures(followUp);
  if (!text && !captures.length) {
    say('Allow the page, or add some text, first.', 'error');
    return false;
  }

  const keepAction = followUp ? (actionId || answerActionId) : actionId;
  // A Reply or Work note is posted to the ticket, so ask for it in a form
  // where the note can be told apart from TerrierGPT's comments to the analyst.
  const postSpec = journalForAction(keepAction);
  const asked = postSpec ? `${text}\n${postingInstruction(postSpec)}` : text;
  const keepTicket = followUp ? (answerTicket || currentPage?.ticket?.number || '') : (currentPage?.ticket?.number || '');
  if (picking) await stopPick(false);
  asking = true;
  stopped = false;
  answerActionId = '';
  answerTicket = '';
  answerPosted = false;
  postArmed = false;
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

  const askId = newAskId();
  const tracker = askTracker();
  currentAsk = { id: askId, tracker };

  try {
    // The direct reply is one of several ways the answer can come back. If the
    // worker was unloaded mid-answer, the reply never comes or the channel
    // closes; the stored result or a direct collect from the tab still lands.
    ask({ type: 'TG_ASK', payload: { instruction: asked, captures, askId } })
      .then((reply) => tracker.reply(reply), () => {});
    let result = await tracker.promise;
    if (!stopped && (result?.reason === 'answer-lost' || result?.reason === 'generation-timeout')) {
      const collected = await ask({ type: 'TG_ASK_COLLECT', payload: { id: askId } }).catch(() => null);
      if (collected?.done && isUsableReply(collected.result)) result = collected.result;
    }
    if (stopped) {
      say('Stopped.');
      return false;
    }
    if (!result?.ok) {
      const message = describe(result?.reason);
      if (answerRaw && result?.reason === 'answer-lost') {
        say('The answer stopped arriving. The text above is what came through; open the TerrierGPT tab for the rest.', 'error');
        return false;
      }
      say(message, 'error');
      if (!answerRaw) showAnswer(message);
      if (result?.reason === 'signed-out') showGear(true);
      return false;
    }
    if (result.text) {
      answerActionId = keepAction || '';
      answerTicket = keepTicket;
      answerPosted = false;
      showAnswer(result.text);
      say('Answer received.', 'ok');
      await rememberAnswer(askedURL, {
        text: result.text,
        label: label || 'Answer',
        agent: agentLabel,
        actionId: answerActionId,
        ticketNumber: answerTicket,
      });
      syncPostButton();
    } else {
      showAnswer(answerRaw || '');
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
    if (currentAsk?.id === askId) currentAsk = null;
    asking = false;
    el.spinner.hidden = true;
    el.stop.hidden = true;
    if (answerRaw) showAnswer(answerRaw, { note: journalForAction(answerActionId) && noteDraft ? noteDraft : null });
    else showAnswer('');
    renderActions();
    // An ask queued while this one ran waited its turn. Pick it up now.
    setTimeout(() => void consumePending(), 50);
  }
}

async function consumePending() {
  if (consumeLock) return consumeLock;
  consumeLock = (async () => {
    await catalogReady;
    const { pendingAsk } = await chrome.storage.session.get('pendingAsk');
    if (!pendingAsk?.id) return;
    // Only the panel for the tab the ask came from takes it: that window's side
    // panel in Chrome, that tab's dock in Safari. Every other panel leaves it.
    await scopeReady;
    const target = { tabId: pendingAsk.tabId ?? undefined, windowId: pendingAsk.windowId ?? undefined };
    if ((pendingAsk.tabId != null || pendingAsk.windowId != null) && !isMine(DOCKED ? { tabId: target.tabId } : target)) return;
    if (asking) return;
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
  const result = await ask({ type: 'TG_SIGN_IN' }).catch(() => null);
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
  void runAsk(instruction, { followUp: Boolean(answerRaw), label: 'Ask', actionId: answerActionId }).then((ok) => {
    if (ok) el.instruction.value = '';
  });
});

el.post.addEventListener('click', () => void postCurrentAnswer());

async function postCurrentAnswer() {
  const spec = journalForAction(answerActionId);
  if (!spec || posting || answerPosted) return;
  const liveNumber = currentPage?.ticket?.number || '';
  const expectNumber = answerTicket || liveNumber;
  if (answerTicket && liveNumber && answerTicket !== liveNumber) {
    postArmed = false;
    syncPostButton();
    say(`This draft is for ${answerTicket}. This tab is ${liveNumber}.`, 'error');
    return;
  }
  const prepared = postRequest({ field: spec.field, text: noteDraft, expectNumber });
  if (!prepared.ok) {
    say(describe(prepared.reason), 'error');
    return;
  }
  if (spec.clientVisible && !postArmed) {
    postArmed = true;
    postArmedAt = Date.now();
    syncPostButton();
    const who = currentPage?.ticket?.caller || 'the client';
    say(`This emails ${who} on ${prepared.expectNumber}. The form reloads, so unsaved edits there are lost. Click Email the client to send it.`, 'error');
    return;
  }
  if (spec.clientVisible && Date.now() - postArmedAt < 600) return;
  postArmed = false;
  posting = true;
  syncPostButton();
  say(spec.clientVisible
    ? `Emailing ${currentPage?.ticket?.caller || 'the client'} on ${prepared.expectNumber}…`
    : `Posting the work note on ${prepared.expectNumber}…`);
  let result;
  try {
    result = await ask({
      type: 'TG_POST_JOURNAL',
      payload: { field: prepared.field, text: prepared.text, expectNumber: prepared.expectNumber },
    });
  } catch (error) {
    posting = false;
    syncPostButton();
    say(String(error), 'error');
    return;
  }
  posting = false;
  if (!result?.ok) {
    syncPostButton();
    if (result?.reason === 'wrong-ticket') {
      say(`This draft is for ${prepared.expectNumber}. The form is ${result.number || 'a different ticket'}.`, 'error');
      return;
    }
    say(describe(result?.reason), 'error');
    return;
  }
  answerPosted = true;
  showAnswer(answerRaw, { note: noteDraft });
  const where = spec.clientVisible ? 'Reply posted. ServiceNow emails the client.' : 'Work note posted.';
  const check = result.confirmed === false ? ' Check the activity stream after the reload.' : '';
  say(`${where} ${result.number || prepared.expectNumber} is reloading.${check}`, 'ok');
  await rememberAnswer(shownURL || currentPage?.url || '', {
    text: answerRaw,
    label: el.answerLabel.textContent,
    agent: el.responseAgent.hidden ? '' : el.responseAgent.textContent,
    actionId: answerActionId,
    ticketNumber: answerTicket || result.number || prepared.expectNumber,
    note: noteDraft,
    posted: true,
  });
}

el.copy.addEventListener('click', async () => {
  postArmed = false;
  syncPostButton();
  if (!answerRaw) return;
  const isNote = Boolean(journalForAction(answerActionId) && noteDraft.trim());
  try {
    await navigator.clipboard.writeText(isNote ? noteDraft : answerRaw);
  } catch {
    say('Could not write to the clipboard.', 'error');
    return;
  }
  el.copy.querySelector('use')?.setAttribute('href', '#i-check');
  say(isNote ? 'Note copied, without TerrierGPT\'s comments.' : 'Answer copied.', 'ok');
  setTimeout(() => el.copy.querySelector('use')?.setAttribute('href', '#i-copy'), 1600);
});

el.openTab.addEventListener('click', () => void ask({ type: 'TG_FOCUS_TAB' }).catch(() => {}));

el.pick.addEventListener('click', () => void togglePick());

el.sendMenu.addEventListener('click', () => void sendHandoff(false));

el.sendRecipes.addEventListener('click', () => void sendHandoff(true));

el.dismiss.addEventListener('click', () => {
  clearAnswer();
  void rememberAnswer(shownURL, null);
});

el.stop.addEventListener('click', async () => {
  stopped = true;
  // Free the panel now, even if the worker never answers the stop.
  currentAsk?.tracker.stop();
  await ask({ type: 'TG_STOP_GENERATION', payload: { askId: currentAsk?.id || null } }).catch(() => {});
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
  if (postArmed) {
    postArmed = false;
    syncPostButton();
    say('Left the reply in the panel.');
    return;
  }
  if (!el.menu.hidden) showMenu(false);
  if (!el.gearMenu.hidden) showGear(false);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  // The picker runs in one tab. Only that tab's panel hears what was picked.
  if (/^TG_PICK/.test(message?.type || '') && !isMine({ tabId: sender?.tab?.id, windowId: sender?.tab?.windowId })) return;
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
  await ask({ type: 'TG_PICK_STOP' }).catch(() => {});
  if (announce) say('Pick cancelled.');
}

async function togglePick() {
  if (picking) {
    await stopPick(true);
    return;
  }
  const result = await ask({ type: 'TG_PICK' }).catch(() => null);
  if (!result?.ok) {
    say(describe(result?.reason || 'no-access'), 'error');
    return;
  }
  setPicking(true);
  say('Click an element on the page. Esc cancels.');
}

async function addPicked(payload) {
  setPicking(false);
  void ask({ type: 'TG_PICK_STOP' }).catch(() => {});
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
  let result = null;
  try {
    result = await ask({
      type: 'TG_HANDOFF',
      payload: {
        wake,
        text,
        title: currentPage?.ticket?.number || currentPage?.title || '',
        url: currentPage?.url || '',
      },
    });
  } catch {
    result = { ok: false, reason: 'bridge-failed' };
  } finally {
    // A thrown send used to leave both hand-off buttons disabled for good.
    handing = false;
    renderActions();
  }
  if (!result?.ok) {
    say(describe(result?.reason || 'bridge-failed'), 'error');
    return;
  }
  const shortened = result.truncated ? ' The text was shortened to fit the handoff.' : '';
  say(wake ? `Sent to the CTS Recipes inbox.${shortened}` : `Saved to TerrierGPT Menu.${shortened}`, 'ok');
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[myCapturesKey]) void refreshCapsules();
  const reread = changes.reread?.newValue;
  // A plain timestamp is an older worker's "every panel"; an object names the tab.
  if (reread && (typeof reread !== 'object' || isMine({ tabId: reread.tabId, windowId: reread.windowId }))) scheduleRefresh();
  if (changes.pendingAsk?.newValue) void consumePending();
  const live = changes.liveAnswer?.newValue;
  // Streamed text belongs to one ask. Another window's answer is never shown here.
  if (asking && currentAsk && live?.text && forAsk(live, currentAsk.id)) {
    currentAsk.tracker.text(live.text);
    showAnswer(live.text, { streaming: true });
  }
  const alive = changes.askAlive?.newValue;
  if (currentAsk && forAsk(alive, currentAsk.id)) {
    currentAsk.tracker.alive();
    // Another window's question is in the TerrierGPT tab; this one takes its turn next.
    if (alive.stage === 'queued' && !answerRaw) say('Waiting for another window\'s question to finish…');
    else if (alive.stage !== 'queued' && el.status.textContent.startsWith('Waiting for another window')) say('Asking TerrierGPT…');
  }
  if (currentAsk && forAsk(changes.askResult?.newValue, currentAsk.id)) currentAsk.tracker.settle(changes.askResult.newValue.result);
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

// Tab events from other windows (Chrome) or other tabs (Safari dock) are not this panel's.
chrome.tabs.onActivated.addListener((info) => {
  if (isMine({ tabId: info.tabId, windowId: info.windowId })) scheduleRefresh();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isMine({ tabId, windowId: tab.windowId })) return;
  const showing = tab.active || DOCKED;
  if (showing && changeInfo.url && picking) void stopPick(false);
  if (showing && (changeInfo.status === 'complete' || changeInfo.url)) scheduleRefresh();
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
  await scopeReady;
  const settings = await getSettings();
  applyInstance(settings.instance);
  await renderAgents(settings.agentId);
  await catalogReady;
  await refreshPage();
  await consumePending();
}

void init();
