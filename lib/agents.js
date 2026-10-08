/**
 * Saved agent shortcuts.
 *
 * The agents on a TerrierGPT instance cannot be listed from here. LibreChat
 * authenticates its API with a bearer token it keeps in the page's memory, not
 * with a cookie, so `GET /api/agents` from the extension answers 401 — and
 * minting a token from the refresh cookie would turn this into an API client
 * and can disturb the session in the user's own tab.
 *
 * What LibreChat does expose is a deep link. `/c/new?agent_id=<id>` is exactly
 * the URL its own "copy link" button puts on the clipboard, so the user brings
 * the agents they care about and we open the link. No tokens, nothing to
 * reverse-engineer, and nothing that breaks when the API changes.
 */

const KEY = 'agents';

/** LibreChat's own test for a real agent id is `startsWith('agent_')`. */
const AGENT_ID = /^agent_[A-Za-z0-9_-]+$/;

/** Accepts a pasted link, URL with agent_id, or a bare id, and returns the id — or null. */
export function parseAgentId(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (AGENT_ID.test(text)) return text;

  try {
    const url = new URL(text, 'https://terriergpt.bu.edu');
    const paramId = url.searchParams.get('agent_id');
    if (paramId && AGENT_ID.test(paramId)) return paramId;

    const match = url.pathname.match(/\b(agent_[A-Za-z0-9_-]+)\b/);
    if (match && AGENT_ID.test(match[1])) return match[1];
  } catch {}

  return null;
}

/** The conversation URL for an agent, in LibreChat's own deep-link form. */
export function chatURL(origin, agentId) {
  return `${origin}/c/new?agent_id=${encodeURIComponent(agentId)}`;
}

/**
 * How long a `/c/new?prompt=…` URL may get before the server in front of
 * TerrierGPT rejects it.
 *
 * Measured against the test instance with a session-sized (1.8 KB) cookie:
 * 13,000 characters of prompt still answers 200, 14,000 answers 431, and
 * 32,000 answers 414. The whole header budget is about 16 KB and the cookie
 * eats into it, so 6,000 for the entire URL keeps better than a 2x margin for
 * larger cookies and any proxy in between.
 */
export const MAX_PROMPT_URL = 6000;

/**
 * A new-conversation URL carrying the prompt itself.
 *
 * LibreChat can read `prompt` off the query string. The companion does not use
 * this for delivery: ticket text would land in Chrome's history and in the
 * server logs. `promptURL` stays for tests. The send path writes the composer.
 */
export function promptURL(origin, { agentId = null, text, autoSend = false }) {
  const params = new URLSearchParams();
  if (agentId) params.set('agent_id', agentId);
  params.set('prompt', text);
  if (autoSend) params.set('submit', 'true');
  return `${origin}/c/new?${params}`;
}

/** A readable fallback name when the user does not give one. */
export function shortLabel(agentId) {
  const tail = agentId.replace(/^agent_/, '');
  return tail.length > 10 ? `Agent ${tail.slice(0, 8)}…` : `Agent ${tail}`;
}

// ------------------------------------------------------------------- storage
//
// Local storage. Sync storage caps one key at 8 KB, and a synced account list
// with descriptions passes that at a few dozen agents, so the write throws.
// Sync rebuilds the list on another Chrome in one click. A list saved by an
// older version in sync storage is moved over the first time it is read.

export async function loadAgents() {
  const { [KEY]: agents } = await chrome.storage.local.get(KEY);
  if (Array.isArray(agents)) return agents;
  const { [KEY]: legacy } = await chrome.storage.sync.get(KEY);
  if (Array.isArray(legacy) && legacy.length) {
    await chrome.storage.local.set({ [KEY]: legacy });
    await chrome.storage.sync.remove(KEY).catch(() => {});
    return legacy;
  }
  return [];
}

export async function saveAgents(agents) {
  await chrome.storage.local.set({ [KEY]: agents });
}

/**
 * Agent ids belong to one instance: an agent made on Test does not exist on
 * Prod. Entries saved before the origin was recorded are shown everywhere.
 */
export function agentsFor(agents, origin) {
  return (agents ?? []).filter((agent) => !agent.origin || !origin || agent.origin === origin);
}

/** Case-insensitive match on name, description, and id, for the agent search box. */
export function searchAgents(agents, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return agents ?? [];
  return (agents ?? []).filter((agent) => {
    const hay = `${agent.name ?? ''} ${agent.description ?? ''} ${agent.id ?? ''}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** A name nobody chose: the id itself, or the `shortLabel` fallback. */
function isPlaceholderName(agent) {
  return !agent.name || agent.name === agent.id || agent.name === shortLabel(agent.id);
}

/** Adds an agent, or renames one that is already saved. Returns the new list. */
export async function addAgent({ id, name, origin = null }) {
  const agents = await loadAgents();
  const label = (name ?? '').trim() || shortLabel(id);
  const existing = agents.find((a) => a.id === id);

  if (existing) {
    existing.name = label;
    if (origin && !existing.origin) existing.origin = origin;
  } else {
    agents.push({ id, name: label, origin, addedAt: Date.now() });
  }

  await saveAgents(agents);
  return agents;
}

export async function removeAgent(id) {
  const agents = (await loadAgents()).filter((a) => a.id !== id);
  await saveAgents(agents);
  return agents;
}

/** Merges a list of discovered agents from the TerrierGPT account without overriding custom labels. */
export async function mergeDiscoveredAgents(discoveredList = [], origin = null) {
  const agents = await loadAgents();
  let changed = false;

  for (const item of discoveredList) {
    if (!item?.id || !AGENT_ID.test(item.id)) continue;
    const named = (item.name ?? '').trim();
    const label = named && named !== item.id ? named : shortLabel(item.id);
    const existing = agents.find((a) => a.id === item.id);
    if (existing) {
      if (isPlaceholderName(existing) && label !== existing.name) {
        existing.name = label;
        changed = true;
      }
      if (item.description && !existing.description) {
        existing.description = item.description;
        changed = true;
      }
      if (origin && !existing.origin) {
        existing.origin = origin;
        changed = true;
      }
    } else {
      agents.push({
        id: item.id,
        name: label,
        description: item.description || null,
        origin,
        addedAt: Date.now(),
        discovered: true,
      });
      changed = true;
    }
  }

  if (changed) {
    await saveAgents(agents);
  }
  return agents;
}

