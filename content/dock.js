/**
 * The side panel, docked inside the page. Safari has no side panel API, so
 * the service worker injects this file when the toolbar button, Alt+Shift+T,
 * the context menu, or a queued ask wants the panel.
 *
 * The panel itself is the same `sidepanel/sidepanel.html`, loaded in an
 * iframe on the extension's origin. Nothing of the page reaches it except
 * through the extension's own messaging. The host element sits on <html>,
 * outside <body>, so page extraction never reads the panel as page text.
 */

// Wrapped so a second injection into the same isolated world does not throw
// "Identifier has already been declared" and silently do nothing.
(() => {
  if (globalThis.__tgDock) return;

  const HOST_ID = '__terriergpt_dock__';
  const WIDTH_KEY = 'dockWidth';
  const MIN_WIDTH = 320;
  const MAX_WIDTH = 640;

  let host = null;
  let frame = null;
  let width = 380;

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'position:fixed',
      'top:0',
      'right:0',
      'bottom:0',
      `width:${width}px`,
      'z-index:2147483646',
      'display:block',
      'transform:translateX(105%)',
      'transition:transform 420ms cubic-bezier(0.22,1.1,0.36,1)',
      'box-shadow:-18px 0 48px rgba(0,0,0,.22),-1px 0 0 rgba(127,127,127,.25)',
      'background:transparent',
    ].join(';');

    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .grip {
        position: absolute; left: -4px; top: 0; bottom: 0; width: 8px;
        cursor: ew-resize; z-index: 2;
      }
      iframe {
        width: 100%; height: 100%; border: 0; display: block;
        color-scheme: normal; background: transparent;
      }
      @media (prefers-reduced-motion: reduce) { :host { transition: none !important; } }
    `;
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', startResize);

    frame = document.createElement('iframe');
    frame.title = 'TerrierGPT Companion';
    frame.allow = 'clipboard-read; clipboard-write';
    frame.src = chrome.runtime.getURL('sidepanel/sidepanel.html?dock=1');

    root.append(style, grip, frame);
    document.documentElement.append(host);
  }

  function startResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    frame.style.pointerEvents = 'none';
    const move = (e) => {
      width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (startX - e.clientX)));
      host.style.width = `${width}px`;
    };
    const up = () => {
      frame.style.pointerEvents = '';
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      chrome.storage.local.set({ [WIDTH_KEY]: width }).catch(() => {});
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  function isOpen() {
    return Boolean(host?.isConnected) && host.dataset.open === 'true';
  }

  async function open() {
    if (!host?.isConnected) {
      try {
        const stored = (await chrome.storage.local.get(WIDTH_KEY))[WIDTH_KEY];
        if (Number.isFinite(stored)) width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stored));
      } catch {}
      build();
    }
    host.dataset.open = 'true';
    requestAnimationFrame(() => {
      host.style.transform = 'translateX(0)';
    });
  }

  function close() {
    if (!host?.isConnected) return;
    host.dataset.open = 'false';
    host.style.transform = 'translateX(105%)';
  }

  function toggle() {
    return isOpen() ? close() : open();
  }

  // The panel's close button posts here. Only its own frame is listened to.
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data?.tg === 'dock-close') close();
  });

  globalThis.__tgDock = { open, close, toggle, isOpen };
})();
