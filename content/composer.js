/**
 * Runs only on the TerrierGPT origins. Puts a composed prompt into the chat
 * composer, handles generation streaming, discovers account agents, and presses Send.
 *
 * Supports both standard <textarea> and [contenteditable="true"] editors,
 * adapts to LibreChat updates via multiple resilient selectors, and watches
 * responses for inline sidepanel streaming.
 */

// Wrapped so a second injection into the same isolated world does not throw
// "Identifier has already been declared" and silently do nothing.
(() => {
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
      '[data-testid="composer-send-button"]',
      '[data-testid="submit-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'form button[type="submit"]',
    ],
    stop: [
      '[data-testid="stop-generation-button"]',
      '[data-testid="composer-stop-button"]',
      'button[aria-label*="Stop"]',
      'button.stop-button',
    ],
    newChat: [
      '[data-testid="new-chat-button"]',
      '[data-testid="header-new-chat-button"]',
      '[data-testid="nav-new-chat-fab"]',
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
  const SIGNED_OUT_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/oauth'];

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
  function assistantTurns() {
    const testid = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'));
    const turns = testid.length ? testid : Array.from(document.querySelectorAll('.agent-turn, [data-message-author-role="assistant"]'));
    return turns.filter((root) => !root.closest('.user-turn, [data-testid="user-message"], [data-message-author-role="user"]'));
  }

  /**
   * The turn's rendered HTML, back as Markdown. `innerText` drops list markers,
   * headings, and code fences, so the panel would get one flat paragraph.
   */
  function toMarkdown(root) {
    const inline = (node) => Array.from(node.childNodes).map(walkInline).join('');
    function walkInline(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName;
      if (tag === 'BR') return '\n';
      if (tag === 'BUTTON' || tag === 'SVG' || node.getAttribute('aria-hidden') === 'true') return '';
      if (tag === 'STRONG' || tag === 'B') return `**${inline(node).trim()}**`;
      if (tag === 'EM' || tag === 'I') return `*${inline(node).trim()}*`;
      if (tag === 'CODE') return `\`${node.textContent}\``;
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        const label = inline(node).trim();
        return /^(https?:|mailto:)/i.test(href) ? `[${label || href}](${href})` : label;
      }
      return inline(node);
    }

    const out = [];
    function block(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue.trim();
        if (text) out.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'BUTTON' || tag === 'svg' || tag === 'SVG' || node.getAttribute('aria-hidden') === 'true') return;
      if (/^H[1-6]$/.test(tag)) {
        out.push(`${'#'.repeat(Math.min(Number(tag[1]), 3))} ${inline(node).trim()}`);
      } else if (tag === 'P') {
        const text = inline(node).trim();
        if (text) out.push(text);
      } else if (tag === 'PRE') {
        const code = node.querySelector('code') || node;
        const lang = (code.className.match(/language-([\w-]+)/) || [])[1] || '';
        out.push(`\`\`\`${lang}\n${code.textContent.replace(/\n$/, '')}\n\`\`\``);
      } else if (tag === 'UL' || tag === 'OL') {
        let n = 1;
        const items = [];
        for (const li of node.children) {
          if (li.tagName !== 'LI') continue;
          const marker = tag === 'OL' ? `${n++}.` : '-';
          const own = Array.from(li.childNodes)
            .filter((child) => !(child.nodeType === Node.ELEMENT_NODE && /^(UL|OL|PRE)$/.test(child.tagName)))
            .map(walkInline).join('').trim();
          items.push(`${'  '.repeat(depth)}${marker} ${own}`);
          for (const nested of li.querySelectorAll(':scope > ul, :scope > ol')) {
            const saved = out.length;
            block(nested, depth + 1);
            items.push(...out.splice(saved));
          }
        }
        out.push(items.join('\n'));
      } else if (tag === 'TABLE') {
        const rows = Array.from(node.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.children).map((cell) => inline(cell).trim().replace(/\|/g, '\\|')));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
          out.push([line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'));
        }
      } else if (tag === 'BLOCKQUOTE') {
        out.push(inline(node).trim().split('\n').map((l) => `> ${l}`).join('\n'));
      } else if (tag === 'HR') {
        out.push('---');
      } else {
        for (const child of node.childNodes) block(child, depth);
      }
    }
    block(root);
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function turnText(root) {
    const prose = root.querySelector('.markdown, .prose, [class*="prose"]');
    if (prose) {
      try {
        const md = toMarkdown(prose);
        if (md) return md;
      } catch {}
    }
    return ((prose || root).innerText || (prose || root).textContent || '').trim();
  }

  /** The newest assistant text, ignoring the first `skip` turns (the ones already on screen before we sent). */
  function readLatestAssistantText(promptText, skip = 0) {
    const prompt = String(promptText || '').trim();
    const turns = assistantTurns().slice(skip);
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const text = turnText(turns[i]);
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

    // A continued conversation already has answers on screen. Only a turn that
    // appears after Send is this question's answer.
    const before = assistantTurns().length;
    const latest = () => readLatestAssistantText(text, before);

    setReactValue(composer, text);
    const sent = await triggerSend(composer);
    if (!sent) return { ok: false, reason: 'send-unavailable' };

    const started = await waitUntil(
      () => isGenerating() || Boolean(latest()),
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
        const finalText = latest() || lastText;
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
        const current = latest();
        if (!current) return;
        settledTimer = setTimeout(() => finish(false), 900);
      };

      const observer = new MutationObserver(() => {
        notifyUpdate(latest());
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

  /**
   * Every agent this account can use, from LibreChat's own list endpoint.
   *
   * The API wants the bearer token LibreChat keeps in page memory, which an
   * isolated content script cannot see. It mints one the same way the page does
   * on every load: POST /api/auth/refresh with the session cookie. LibreChat
   * already does this from every open tab, so one more call is ordinary traffic.
   * The token stays inside this function and is never sent to the extension.
   */
  async function listAccountAgents() {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!refresh.ok) return { ok: false, reason: refresh.status === 401 ? 'signed-out' : 'agents-api' };
    const token = (await refresh.json().catch(() => null))?.token;
    if (!token) return { ok: false, reason: 'signed-out' };

    const agents = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ requiredPermission: '1', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/agents?${params}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return { ok: false, reason: 'agents-api', status: response.status };
      const body = await response.json().catch(() => null);
      for (const agent of body?.data ?? []) {
        if (!agent?.id || !/^agent_[A-Za-z0-9_-]+$/.test(agent.id)) continue;
        agents.push({
          id: agent.id,
          name: String(agent.name || '').trim(),
          description: String(agent.description || '').trim().slice(0, 280),
        });
      }
      cursor = body?.after || '';
      if (!cursor || !body?.has_more) break;
    }
    return { ok: true, agents, source: 'api' };
  }

  /** What the open page shows: agent links and the conversation's own agent. A fallback for the API. */
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

  // LibreChat navigates with pushState, which fires no event a content script
  // can hear. A cheap URL check catches agent conversations opened in-app.
  let lastHref = '';
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    reportActiveAgent();
  }, 1500);

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
      (async () => {
        let api = null;
        try {
          api = await listAccountAgents();
        } catch (error) {
          api = { ok: false, reason: 'agents-api', detail: String(error) };
        }
        if (api.ok) {
          sendResponse(api);
          return;
        }
        if (api.reason === 'signed-out' && isSignedOut()) {
          sendResponse({ ok: false, reason: 'signed-out' });
          return;
        }
        sendResponse({ ok: true, agents: discoverAccountAgents(), source: 'page', apiReason: api.reason });
      })();
      return true;
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
})();
