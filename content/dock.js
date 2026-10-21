/**
 * The side panel, docked inside the page. Safari has no side panel API, so
 * the service worker injects this file when the toolbar button, Alt+Shift+T,
 * the context menu, or a queued ask wants the panel.
 *
 * The panel itself is the same `sidepanel/sidepanel.html`, loaded in an
 * iframe on the extension's origin. Nothing of the page reaches it except
 * through the extension's own messaging. The host element sits on <html>,
 * outside <body>, so page extraction never reads the panel as page text.
 *
 * The iframe lives in the light DOM (not a closed shadow root). Safari does
 * not reliably deliver clicks or typing to extension pages inside a closed
 * shadow tree, which left the dock looking open but completely inert.
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
  let grip = null;
  let width = 380;

  function ensureStyles() {
    if (document.getElementById('__terriergpt_dock_css__')) return;
    const style = document.createElement('style');
    style.id = '__terriergpt_dock_css__';
    style.textContent = `
      #${HOST_ID} {
        all: initial;
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483646;
        display: block;
        box-sizing: border-box;
        background: transparent;
        box-shadow: -18px 0 48px rgba(0,0,0,.22), -1px 0 0 rgba(127,127,127,.25);
        transition: transform 420ms cubic-bezier(0.22,1.1,0.36,1);
      }
      #${HOST_ID}[data-open="false"] {
        pointer-events: none;
        transform: translateX(105%);
      }
      #${HOST_ID}[data-open="true"] {
        pointer-events: auto;
        transform: translateX(0);
      }
      #${HOST_ID} .tg-dock-grip {
        position: absolute;
        left: -4px;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
        z-index: 2;
      }
      #${HOST_ID} iframe.tg-dock-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        color-scheme: normal;
        background: transparent;
        pointer-events: auto;
      }
      @media (prefers-reduced-motion: reduce) {
        #${HOST_ID} { transition: none !important; }
      }
    `;
    document.documentElement.append(style);
  }

  function build() {
    ensureStyles();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.open = 'false';
    host.style.width = `${width}px`;

    grip = document.createElement('div');
    grip.className = 'tg-dock-grip';
    grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', startResize);

    frame = document.createElement('iframe');
    frame.className = 'tg-dock-frame';
    frame.title = 'TerrierGPT Companion';
    frame.allow = 'clipboard-read; clipboard-write';
    // Extension pages need an explicit tabIndex so Safari will focus inputs inside.
    frame.tabIndex = 0;
    frame.src = chrome.runtime.getURL('sidepanel/sidepanel.html?dock=1');

    host.append(grip, frame);
    document.documentElement.append(host);
  }

  function startResize(event) {
    if (!host || !frame) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    frame.style.pointerEvents = 'none';
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {}

    const move = (e) => {
      width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (startX - e.clientX)));
      host.style.width = `${width}px`;
    };
    const finish = () => {
      frame.style.pointerEvents = 'auto';
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      try {
        grip.releasePointerCapture(event.pointerId);
      } catch {}
      chrome.storage.local.set({ [WIDTH_KEY]: width }).catch(() => {});
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
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
    host.style.width = `${width}px`;
    host.dataset.open = 'true';
    // Nudge Safari to focus the dock so the ask field can take keystrokes.
    requestAnimationFrame(() => {
      try {
        frame?.contentWindow?.focus();
      } catch {}
    });
  }

  function close() {
    if (!host?.isConnected) return;
    host.dataset.open = 'false';
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
