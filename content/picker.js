/**
 * On-demand element picker. The service worker injects this file into the
 * active tab when the panel's Pick button is pressed. It is not a standing
 * content script.
 *
 * A click adds one block as context. Password fields are ignored. Escape
 * leaves the page as it was.
 */

const PICK_MAX = 8000;

function fieldName(id) {
  const match = String(id || '').match(/^(?:sys_(?:display|readonly)\.)?([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]+)$/);
  if (!match) return '';
  const words = match[2].replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function firstLine(value, max) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function labelFor(snapshot) {
  const field = fieldName(snapshot?.id);
  if (field) return field;
  const aria = firstLine(snapshot?.ariaLabel, 60);
  if (aria) return aria;
  const labelled = firstLine(snapshot?.labelText, 60);
  if (labelled) return labelled;
  const heading = firstLine(snapshot?.heading, 60);
  if (heading) return heading;
  const line = firstLine(snapshot?.text, 42);
  if (line) return line;
  return snapshot?.tag ? String(snapshot.tag).toLowerCase() : 'Selection';
}

function textFor(snapshot, max = PICK_MAX) {
  const raw = String(snapshot?.value || snapshot?.text || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
  if (!raw) return { text: '', truncated: false };
  if (raw.length <= max) return { text: raw, truncated: false };
  return { text: raw.slice(0, max), truncated: true };
}

function controlValue(node) {
  if (!node) return '';
  if (node.tagName === 'TEXTAREA') return node.value || '';
  if (node.tagName === 'INPUT') {
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') return '';
    return node.value || '';
  }
  if (node.tagName === 'SELECT') return node.options[node.selectedIndex]?.text || '';
  return '';
}

function headingNear(node) {
  let current = node;
  let depth = 0;
  while (current && current !== document.body && depth < 6) {
    if (/^H[1-6]$/.test(current.tagName)) return current.innerText || '';
    let sibling = current.previousElementSibling;
    let steps = 0;
    while (sibling && steps < 8) {
      if (/^H[1-6]$/.test(sibling.tagName)) return sibling.innerText || '';
      sibling = sibling.previousElementSibling;
      steps += 1;
    }
    current = current.parentElement;
    depth += 1;
  }
  return '';
}

function snapshotOf(node) {
  const id = node.id || '';
  let labelText = '';
  if (id && typeof CSS !== 'undefined' && CSS.escape) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    labelText = label?.innerText || '';
  }
  if (!labelText) {
    const wrap = node.closest?.('label');
    if (wrap && wrap !== node) labelText = wrap.innerText || '';
  }
  return {
    id,
    tag: node.tagName || '',
    ariaLabel: node.getAttribute?.('aria-label') || '',
    labelText,
    heading: headingNear(node),
    value: controlValue(node),
    text: node.innerText || node.textContent || '',
  };
}

function blockFor(node) {
  let current = node;
  while (current && current !== document.body) {
    if (fieldName(current.id)) return current;
    current = current.parentElement;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return node;
  const blocks = /^(P|LI|TD|TH|PRE|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|ARTICLE|DD|DT|FIGCAPTION)$/;
  current = node;
  while (current && current !== document.body) {
    if (blocks.test(current.tagName)) return current;
    current = current.parentElement;
  }
  return node;
}

function isPassword(node) {
  const field = node.closest?.('input');
  return (field?.getAttribute('type') || '').toLowerCase() === 'password';
}

function installPicker() {
  if (globalThis.__tgPicker) {
    globalThis.__tgPicker.arm();
    return;
  }

  let armed = false;
  let suppressClick = false;
  let box = null;
  let chip = null;
  let previousCursor = '';
  let frame = 0;
  let pending = null;

  function overlay() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'tg-pick-overlay';
    box.style.position = 'fixed';
    box.style.pointerEvents = 'none';
    box.style.zIndex = '2147483647';
    box.style.border = '2px solid #CC0A21';
    box.style.background = 'rgba(204, 10, 33, 0.12)';
    box.style.borderRadius = '4px';
    box.style.boxSizing = 'border-box';
    box.hidden = true;
    chip = document.createElement('div');
    chip.style.position = 'absolute';
    chip.style.left = '0';
    chip.style.bottom = '100%';
    chip.style.marginBottom = '2px';
    chip.style.background = '#CC0A21';
    chip.style.color = '#fff';
    chip.style.font = '600 11px/1.2 -apple-system, BlinkMacSystemFont, sans-serif';
    chip.style.padding = '2px 6px';
    chip.style.borderRadius = '4px';
    chip.style.whiteSpace = 'nowrap';
    chip.style.maxWidth = '240px';
    chip.style.overflow = 'hidden';
    chip.style.textOverflow = 'ellipsis';
    box.append(chip);
    (document.documentElement || document.body).append(box);
    return box;
  }

  function paint(node) {
    const target = blockFor(node);
    if (!target || target === document.body || target === document.documentElement) {
      if (box) box.hidden = true;
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) {
      if (box) box.hidden = true;
      return;
    }
    const layer = overlay();
    layer.hidden = false;
    layer.style.top = `${Math.max(rect.top, 0)}px`;
    layer.style.left = `${Math.max(rect.left, 0)}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    chip.textContent = labelFor(snapshotOf(target));
  }

  function onMove(event) {
    if (!armed) return;
    const node = event.target;
    if (!node || node === box || node === chip) return;
    pending = node;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (armed && pending) paint(pending);
    });
  }

  function pick(node) {
    if (!node || node === box || node === chip) return;
    if (isPassword(node)) return;
    const target = blockFor(node);
    if (!target || target === document.body || target === document.documentElement) return;
    const snap = snapshotOf(target);
    const described = textFor(snap);
    if (!described.text) {
      chrome.runtime.sendMessage({ type: 'TG_PICK_EMPTY' });
      return;
    }
    chrome.runtime.sendMessage({
      type: 'TG_PICKED',
      payload: {
        label: labelFor(snap),
        text: described.text,
        truncated: described.truncated,
        url: location.href,
      },
    });
    disarm();
  }

  // Cancelling pointerdown also cancels the click in Chrome. Pick here, and
  // swallow a click if one still arrives so the page control does not fire.
  function onPointerDown(event) {
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = true;
    pick(event.target);
  }

  function onClick(event) {
    if (!suppressClick && !armed) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  }

  function onKey(event) {
    if (!armed || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: 'TG_PICK_CANCELLED' });
    disarm();
  }

  function arm() {
    armed = true;
    previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';
  }

  function disarm() {
    armed = false;
    pending = null;
    document.documentElement.style.cursor = previousCursor;
    if (box) box.remove();
    box = null;
    chip = null;
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  document.addEventListener('keydown', onKey, true);

  globalThis.__tgPicker = { arm, disarm, fieldName, labelFor, textFor };
  arm();
}

globalThis.TGPick = { fieldName, labelFor, textFor };

if (typeof document !== 'undefined') installPicker();
