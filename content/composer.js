/**
 * Runs only on the TerrierGPT origins. Puts a composed prompt into the chat
 * composer, handles generation streaming, discovers account agents, and presses Send.
 *
 * Supports both standard <textarea> and [contenteditable="true"] editors,
 * adapts to LibreChat updates via multiple resilient selectors, and watches
 * responses for inline sidepanel streaming.
 */

const SELECTORS = {
  composer: [
    '#prompt-textarea',
    '[data-testid="text-input"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Terrier"]',
  ],
  send: [
    '[data-testid="send-button"]',
    '[data-testid="submit-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Submit"]',
    'form button[type="submit"]',
  ],
  stop: [
    '[data-testid="stop-generation-button"]',
    'button[aria-label*="Stop"]',
    'button.stop-button',
  ],
  newChat: [
    '[data-testid="new-chat-button"]',
    'a[href="/c/new"]',
    'button[aria-label*="New chat"]',
  ],
  login: [
    '[data-testid="login-button"]',
    'a[href*="/login"]',
    'button[aria-label*="Log in"]',
  ],
};

const NEW_CHAT_PATH = '/c/new';
const SIGNED_OUT_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return r.width > 20 && r.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
}

function findElement(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    const nodes = Array.from(document.querySelectorAll(sel));
    const visible = nodes.filter(isVisible);
    if (visible.length) return visible[visible.length - 1];
  }
  return null;
}

function findComposer() {
  const specific = findElement(SELECTORS.composer);
  if (specific) return specific;
  // A bare textarea matches search boxes. Stay inside the form that owns Send.
  const send = findSendButton();
  const form = send?.closest('form') || document.querySelector('form[data-testid], form');
  const scoped = form?.querySelector('textarea, [contenteditable="true"]');
  return isVisible(scoped) ? scoped : null;
}

function waitForComposer(timeout = 6000) {
  const existing = findComposer();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = findComposer();
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function findSendButton() {
  return findElement(SELECTORS.send);
}

function findStopButton() {
  return findElement(SELECTORS.stop);
}

/** Resolves with matching element or null on timeout. */
function waitFor(selectors, timeout = 6000) {
  const existing = findElement(selectors);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = findElement(selectors);
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function waitUntil(test, timeout = 6000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let ok = false;
      try {
        ok = test();
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Sets value on textarea/input or contenteditable so React internal state tracks it. */
function setReactValue(el, text) {
  el.focus();
  el.click();

  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
    try {
      document.execCommand('selectAll', false, null);
    } catch {}
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function isSignedOut() {
  if (findComposer()) return false;
  return (
    SIGNED_OUT_PATHS.some((path) => location.pathname.startsWith(path)) ||
    Boolean(findElement(SELECTORS.login))
  );
}

function isGenerating() {
  return Boolean(findStopButton());
}

async function startNewChat() {
  if (location.pathname === NEW_CHAT_PATH) return true;

  const button = findElement(SELECTORS.newChat);
  if (!button) return false;

  button.click();
  return waitUntil(() => location.pathname === NEW_CHAT_PATH, 4000);
}

/** Submits the prompt either by clicking Send or simulating Enter key. */
async function triggerSend(composer) {
  const ready = await waitUntil(() => {
    const send = findSendButton();
    return Boolean(send) && !send.disabled;
  }, 3000);

  const send = findSendButton();
  if (send && !send.disabled) {
    send.click();
    return true;
  }

  // Keyboard Enter fallback
  if (composer) {
    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
    return true;
  }

  return false;
}

async function inject({ text, autoSend, newChat }) {
  if (!text) return { ok: false, reason: 'empty-prompt' };
  if (isSignedOut()) return { ok: false, reason: 'signed-out' };
  if (isGenerating()) return { ok: false, reason: 'busy' };

  let startedNewChat = false;
  if (newChat) startedNewChat = await startNewChat();

  const composer = await waitForComposer();
  if (!composer) return { ok: false, reason: 'composer-not-found' };

  setReactValue(composer, text);

  const ready = await waitUntil(() => {
    const send = findSendButton();
    return Boolean(send) && !send.disabled;
  }, 3000);

  if (!autoSend) {
    return { ok: true, sent: false, startedNewChat, sendReady: ready };
  }

  const sent = await triggerSend(composer);
  return { ok: true, sent, startedNewChat, sendReady: ready };
}

/**
 * LibreChat marks the assistant turn as `.agent-turn`. A newer build also sets
 * `data-testid="assistant-message"`. User turns are `.user-turn`. Reading the
 * last node that merely looks like a message returns the prompt we just sent.
 */
function readLatestAssistantText(promptText) {
  const prompt = String(promptText || '').trim();
  const testid = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'));
  const turns = testid.length ? testid : Array.from(document.querySelectorAll('.agent-turn, [data-message-author-role="assistant"]'));
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const root = turns[i];
    if (root.closest('.user-turn, [data-testid="user-message"], [data-message-author-role="user"]')) continue;
    const prose = root.querySelector('.markdown, .prose, [class*="prose"]') || root;
    const text = (prose.innerText || prose.textContent || '').trim();
    if (!text || text === prompt) continue;
    return text;
  }
  return '';
}

/** Injects prompt, presses send, and streams the assistant turn back. */
async function askAndWait({ text, newChat }) {
  if (!text) return { ok: false, reason: 'empty-prompt' };
  if (isSignedOut()) return { ok: false, reason: 'signed-out' };
  if (isGenerating()) return { ok: false, reason: 'busy' };

  let startedNewChat = false;
  if (newChat) startedNewChat = await startNewChat();

  const composer = await waitForComposer();
  if (!composer) return { ok: false, reason: 'composer-not-found' };

  setReactValue(composer, text);
  const sent = await triggerSend(composer);
  if (!sent) return { ok: false, reason: 'send-unavailable' };

  const started = await waitUntil(
    () => isGenerating() || Boolean(readLatestAssistantText(text)),
    12000,
  );
  if (!started) {
    const errorAlert = document.querySelector('[role="alert"]');
    if (errorAlert && errorAlert.textContent.trim()) {
      return { ok: false, reason: 'generation-failed', detail: errorAlert.textContent.trim().slice(0, 300) };
    }
    return { ok: false, reason: 'generation-timeout' };
  }

  return new Promise((resolve) => {
    let lastText = '';
    let settledTimer = null;
    let settled = false;

    const notifyUpdate = (streamText) => {
      if (streamText && streamText !== lastText) {
        lastText = streamText;
        try {
          chrome.runtime.sendMessage({
            type: 'TG_STREAM_UPDATE',
            payload: { text: streamText, isDone: false },
          });
        } catch {}
      }
    };

    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(settledTimer);
      clearTimeout(maxTimeout);
      const finalText = readLatestAssistantText(text) || lastText;
      if (!finalText) {
        resolve({ ok: false, reason: timedOut ? 'generation-timeout' : 'generation-failed' });
        return;
      }
      resolve({
        ok: true,
        text: finalText,
        conversationUrl: location.href,
        startedNewChat,
      });
    };

    // Finish only once tokens have stopped and the stop button is gone.
    // A debounce handles builds that never render a stop button: streaming
    // keeps resetting the timer, and a quiet second means the turn is done.
    const scheduleFinish = () => {
      clearTimeout(settledTimer);
      if (isGenerating()) return;
      const current = readLatestAssistantText(text);
      if (!current) return;
      settledTimer = setTimeout(() => finish(false), 900);
    };

    const observer = new MutationObserver(() => {
      notifyUpdate(readLatestAssistantText(text));
      scheduleFinish();
    });

    observer.observe(document.querySelector('main') || document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleFinish();

    const maxTimeout = setTimeout(() => finish(true), 240000);
  });
}

/** Discovers all custom agents created or visible in this TerrierGPT session. */
function discoverAccountAgents() {
  const found = new Map();
  const AGENT_ID = /^agent_[A-Za-z0-9_-]+$/;

  // 1. Scan links for agent_id
  for (const a of document.querySelectorAll('a[href*="agent_id="]')) {
    try {
      const url = new URL(a.href, location.origin);
      const id = url.searchParams.get('agent_id');
      if (id && AGENT_ID.test(id)) {
        const name = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim();
        found.set(id, { id, name: name || id });
      }
    } catch {}
  }

  // 2. Scan elements with data attributes
  for (const el of document.querySelectorAll('[data-agent-id], [data-testid*="agent_"]')) {
    const id = el.getAttribute('data-agent-id') || el.getAttribute('data-testid')?.match(/(agent_[A-Za-z0-9_-]+)/)?.[1];
    if (id && AGENT_ID.test(id)) {
      const name = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (!found.has(id) || !found.get(id).name) {
        found.set(id, { id, name: name || id });
      }
    }
  }

  // The open conversation's id, without borrowing the document title as a name.
  // Titles are "TerrierGPT" or the chat subject, and a bad name sticks.
  try {
    const url = new URL(location.href);
    const currentId = url.searchParams.get('agent_id');
    if (currentId && AGENT_ID.test(currentId) && !found.has(currentId)) {
      found.set(currentId, { id: currentId });
    }
  } catch {}

  return Array.from(found.values());
}

function readSelection() {
  const text = String(window.getSelection() ?? '').trim();
  return { ok: true, text, title: document.title, url: location.href };
}

// Token stamp to avoid duplicate listeners on reload
const LOAD_TOKEN = `${Date.now()}-${Math.random()}`;
globalThis.__terrierGPTComposerLoad = LOAD_TOKEN;

// Auto-report visited agents to the background extension
function reportActiveAgent() {
  try {
    const url = new URL(location.href);
    const agentId = url.searchParams.get('agent_id');
    if (agentId && /^agent_[A-Za-z0-9_-]+$/.test(agentId)) {
      chrome.runtime.sendMessage({
        type: 'TG_AGENT_DISCOVERED',
        payload: { id: agentId },
      });
    }
  } catch {}
}

window.addEventListener('popstate', reportActiveAgent);
setTimeout(reportActiveAgent, 1500);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (globalThis.__terrierGPTComposerLoad !== LOAD_TOKEN) return false;

  if (message?.type === 'TG_PING') {
    sendResponse({ ok: true, path: location.pathname, signedIn: !isSignedOut() });
    return false;
  }

  if (message?.type === 'TG_CONFIRM') {
    (async () => {
      const composer = await waitForComposer();
      if (!composer) {
        sendResponse({ ok: false, reason: 'composer-not-found' });
        return;
      }
      const filled = await waitUntil(() => {
        const val = composer.value || composer.textContent || '';
        return val.trim().length > 0;
      }, 6000);
      sendResponse({ ok: true, filled });
    })();
    return true;
  }

  if (message?.type === 'TG_READ_SELECTION') {
    sendResponse(readSelection());
    return false;
  }

  if (message?.type === 'TG_DISCOVER_AGENTS') {
    const agents = discoverAccountAgents();
    sendResponse({ ok: true, agents });
    return false;
  }

  if (message?.type === 'TG_STOP_GENERATION') {
    const btn = findStopButton();
    if (btn) btn.click();
    sendResponse({ ok: Boolean(btn) });
    return false;
  }

  if (message?.type === 'TG_INJECT') {
    (async () => {
      try {
        sendResponse(await inject(message.payload ?? {}));
      } catch (error) {
        sendResponse({ ok: false, reason: 'exception', detail: String(error) });
      }
    })();
    return true;
  }

  if (message?.type === 'TG_ASK_AND_WAIT') {
    (async () => {
      try {
        sendResponse(await askAndWait(message.payload ?? {}));
      } catch (error) {
        sendResponse({ ok: false, reason: 'exception', detail: String(error) });
      }
    })();
    return true;
  }

  return false;
});
