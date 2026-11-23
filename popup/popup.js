/**
 * The iOS popup. Reads the page or ServiceNow ticket in the tab and hands it to
 * TerrierGPT for iPhone through the app extension. If TerrierGPT is open on the
 * other half of the screen it shows up there on its own; otherwise the user
 * taps Open TerrierGPT. The app is never opened uninvited: in split view that
 * would push Safari off the screen.
 */
import { describe } from '../lib/messages.js';

const $ = (id) => document.getElementById(id);
let page = null;
let mode = 'page';

const APP_REASONS = {
  'bridge-missing': 'Open TerrierGPT once, then try again.',
  'bridge-failed': 'TerrierGPT did not answer. Open it and try again.',
};

function reason(code) {
  return APP_REASONS[code] || describe(code);
}

/**
 * A message to the worker. A worker that is gone (unloaded, or the extension
 * reloading) rejects; that comes back as a failure with the browser's reason.
 */
async function request(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, reason: 'exception', unreachable: true, detail: String(error?.message || error) };
  }
}

/** What went wrong, in words: the table's text, or the browser's own reason. */
function failure(reply, fallback) {
  if (reply?.unreachable) return `Could not reach the extension: ${reply.detail}`;
  return reason(reply?.reason || fallback);
}

function setStatus(text, tone = '') {
  $('status').textContent = text;
  $('status').className = `status ${tone}`.trim();
}

function render() {
  const ticket = page?.kind === 'ticket' && mode === 'page';
  const body = mode === 'selection' ? page?.selection : page?.body;
  $('kind').textContent = mode === 'selection' ? 'Selection' : ticket ? page.ticket?.number || 'Ticket' : 'Page';
  $('kind').className = `badge ${mode === 'selection' ? 'tint-violet' : ticket ? 'tint-scarlet' : 'tint-azure'}`;
  $('title').textContent = page?.title || 'This page';
  $('host').textContent = page?.host || '';
  $('size').textContent = body ? `${body.length.toLocaleString()} characters` : '';
  for (const button of document.querySelectorAll('#modes button')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === mode));
  }
  $('send').disabled = !body;
}

async function load() {
  const read = await request({ type: 'TG_READ_ACTIVE_TAB' });
  if (!read?.ok) {
    $('title').textContent = read?.tab?.title || 'This page';
    $('host').textContent = read?.tab?.host || '';
    setStatus(failure(read, 'no-content'), 'error');
    return;
  }
  page = read.page;
  $('modes').hidden = !page.selection;
  if (page.selection && page.kind !== 'ticket') mode = 'selection';
  render();
}

async function send() {
  $('send').disabled = true;
  $('send-label').textContent = 'Sending…';
  setStatus('');
  const reply = await request({ type: 'TG_SEND_TO_APP', payload: { mode } });
  if (reply?.ok) {
    $('send').classList.add('done');
    $('send-label').textContent = 'Sent';
    setStatus('It is in TerrierGPT’s context tray.');
    $('open-app').hidden = false;
    return;
  }
  $('send').disabled = false;
  $('send-label').textContent = 'Send to TerrierGPT';
  setStatus(failure(reply, 'unknown-message'), 'error');
}

$('send').addEventListener('click', send);
for (const button of document.querySelectorAll('#modes button')) {
  button.addEventListener('click', () => {
    mode = button.dataset.mode;
    render();
  });
}
$('open-dock').addEventListener('click', async () => {
  const reply = await request({ type: 'TG_OPEN_DOCK' });
  if (reply?.ok) window.close();
  else setStatus(failure(reply, 'unsupported-page'), 'error');
});

load();
