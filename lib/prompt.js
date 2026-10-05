/**
 * Captures and prompt composition.
 *
 * Deliberately the same shape as `CapturedContext` / `PromptComposer` in the
 * TerrierGPT macOS menu-bar app, so a prompt composed here and one composed
 * there read identically to the model.
 */

/** Where a capture came from. Drives the chip's label and tint. */
export const SOURCE = {
  selection: { id: 'selection', label: 'Selection', tint: 'violet' },
  page: { id: 'page', label: 'Page', tint: 'blue' },
  link: { id: 'link', label: 'Link', tint: 'cyan' },
  clipboard: { id: 'clipboard', label: 'Clipboard', tint: 'emerald' },
  note: { id: 'note', label: 'Note', tint: 'scarlet' },
  /** Matches `CapturedContext.Source.answer` in the menu bar app. */
  answer: { id: 'answer', label: 'Answer', tint: 'scarlet' },
};

export const DEFAULT_INSTRUCTION = 'Help me with the following content.';

/** A capture is inert data: the text plus enough provenance to render an honest chip. */
export function makeCapture({ source, title = '', detail = null, url = null, body = '', partial = null }) {
  return {
    id: crypto.randomUUID(),
    source,
    title,
    detail,
    url,
    body,
    enabled: true,
    partial,
    capturedAt: Date.now(),
  };
}

/** The block this capture contributes to the composed prompt. */
function promptBlock(capture) {
  const label = SOURCE[capture.source]?.label ?? capture.source;
  let header = `--- ${label}`;
  if (capture.title) header += `: ${capture.title}`;
  header += ' ---';

  const lines = [header];
  if (capture.url) lines.push(`Source: ${capture.url}`);
  lines.push('');
  lines.push(capture.body);
  return lines.join('\n');
}

/** Builds the final prompt from an instruction plus whichever captures are switched on. */
export function compose(instruction, captures) {
  const enabled = (captures ?? []).filter((c) => c.enabled && c.body?.trim());
  const lead = (instruction ?? '').trim() || DEFAULT_INSTRUCTION;
  if (enabled.length === 0) return lead;
  return [lead, '', ...enabled.map(promptBlock)].join('\n');
}

/** Rough size indicator shown on the chip so the user sees what they are about to send. */
export function totalChars(captures) {
  return (captures ?? [])
    .filter((c) => c.enabled)
    .reduce((sum, c) => sum + (c.body?.length ?? 0), 0);
}

// ---------------------------------------------------------------- capture store
//
// Captures live in session storage: they are scratch context for the browsing
// session, not something worth persisting to disk across restarts.

const KEY = 'captures';

export async function loadCaptures() {
  const { [KEY]: captures = [] } = await chrome.storage.session.get(KEY);
  return captures;
}

export async function saveCaptures(captures) {
  await chrome.storage.session.set({ [KEY]: captures });
}

export async function addCapture(capture) {
  const captures = await loadCaptures();
  captures.push(capture);
  await saveCaptures(captures);
  return captures;
}

export async function clearCaptures() {
  await chrome.storage.session.remove(KEY);
}
