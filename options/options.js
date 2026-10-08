/** Settings, plus a place to see and revoke the site access the panel asked for. */

import { INSTANCES, getSettings, setSettings, DEFAULTS } from '../lib/config.js';
import { loadAgents, removeAgent } from '../lib/agents.js';
import { describe } from '../lib/messages.js';

const el = {
  instance: document.getElementById('instance'),
  instanceNote: document.getElementById('instance-note'),
  newChat: document.getElementById('new-chat'),
  maxChars: document.getElementById('max-chars'),
  agents: document.getElementById('agents'),
  noAgents: document.getElementById('no-agents'),
  syncAgents: document.getElementById('sync-agents'),
  origins: document.getElementById('origins'),
  noOrigins: document.getElementById('no-origins'),
  status: document.getElementById('status'),
};

function say(message) {
  el.status.textContent = message;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => {
    el.status.textContent = '';
  }, 4000);
}

/** Origins the extension was granted at runtime — the two TerrierGPT hosts are
 *  in the manifest and cannot be revoked, so they are not listed here. */
async function renderOrigins() {
  const granted = await chrome.permissions.getAll();
  const manifestHosts = new Set(chrome.runtime.getManifest().host_permissions ?? []);
  const optional = (granted.origins ?? []).filter((o) => !manifestHosts.has(o));

  el.origins.replaceChildren();
  el.noOrigins.hidden = optional.length > 0;

  for (const origin of optional) {
    const li = document.createElement('li');
    li.className = 'chip glass';

    const label = document.createElement('div');
    label.className = 'chip-title';
    label.textContent = origin;

    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'link-btn';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await renderOrigins();
      say(`Revoked ${origin}`);
    });

    li.append(label, revoke);
    el.origins.append(li);
  }
}

async function renderAgents() {
  const agents = await loadAgents();
  el.agents.replaceChildren();
  el.noAgents.hidden = agents.length > 0;

  for (const agent of agents) {
    const li = document.createElement('li');
    li.className = 'chip glass';

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'chip-title';
    name.textContent = agent.name;
    const id = document.createElement('div');
    id.className = 'chip-meta';
    const where = Object.values(INSTANCES).find((instance) => instance.origin === agent.origin);
    id.textContent = [where?.label, agent.description, agent.id].filter(Boolean).join(' · ');
    body.append(name, id);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-btn';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await removeAgent(agent.id);
      const { agentId } = await getSettings();
      if (agentId === agent.id) await setSettings({ agentId: null });
      await renderAgents();
      say(`Removed ${agent.name}`);
    });

    li.append(body, remove);
    el.agents.append(li);
  }
}

function describeInstance(id) {
  const instance = INSTANCES[id];
  if (!instance) return '';
  return id === 'test'
    ? `${instance.origin} — the non-production instance. The panel shows a TEST badge.`
    : `${instance.origin} — the campus instance. This is the default.`;
}

async function init() {
  for (const instance of Object.values(INSTANCES)) {
    const option = document.createElement('option');
    option.value = instance.id;
    option.textContent = instance.label;
    el.instance.append(option);
  }

  const settings = await getSettings();
  el.instance.value = settings.instance;
  el.instanceNote.textContent = describeInstance(settings.instance);
  el.newChat.checked = settings.newChatPerSend;
  el.maxChars.value = settings.maxPageChars;

  await renderAgents();
  await renderOrigins();
}

el.instance.addEventListener('change', async () => {
  await setSettings({ instance: el.instance.value });
  el.instanceNote.textContent = describeInstance(el.instance.value);
  say('Saved');
});

el.newChat.addEventListener('change', async () => {
  await setSettings({ newChatPerSend: el.newChat.checked });
  say('Saved');
});

el.maxChars.addEventListener('change', async () => {
  const value = Number(el.maxChars.value);
  if (!Number.isFinite(value) || value < 1000) {
    el.maxChars.value = DEFAULTS.maxPageChars;
    return;
  }
  await setSettings({ maxPageChars: Math.min(value, 200000) });
  say('Saved');
});

el.syncAgents?.addEventListener('click', async () => {
  say('Scanning TerrierGPT tab for account agents…');
  el.syncAgents.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TG_SYNC_AGENTS' });
    if (res?.ok) {
      await renderAgents();
      say(res.source === 'api'
        ? `Found ${res.discoveredCount} agent${res.discoveredCount === 1 ? '' : 's'} in your TerrierGPT account.`
        : `Found ${res.discoveredCount} agent${res.discoveredCount === 1 ? '' : 's'} on the open page. The account list did not answer.`);
    } else {
      say(describe(res?.reason));
    }
  } catch (err) {
    say(String(err));
  } finally {
    el.syncAgents.disabled = false;
  }
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.agents) void renderAgents();
});
chrome.permissions.onAdded.addListener(() => void renderOrigins());
chrome.permissions.onRemoved.addListener(() => void renderOrigins());

void init();
