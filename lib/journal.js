/**
 * Post a drafted Reply or Work note onto the ServiceNow ticket already open.
 *
 * The form's Update button cannot be clicked from a script: ServiceNow rejects
 * that submission and bounces it to the security interceptor. The write goes
 * through the Table API in the page's own session instead, which is the same
 * record a typed note lands on. The form then reloads so the activity stream
 * shows it.
 *
 * `postJournalInPage` is handed to chrome.scripting.executeScript in the page's
 * MAIN world. It must stay self-contained: no imports, no closed-over bindings.
 */

/** Which journal field an action is allowed to write. Triage and Summarize are not notes. */
export function journalForAction(actionId) {
  if (actionId === 'reply') {
    return {
      field: 'comments',
      clientVisible: true,
      verb: 'Post reply',
      confirm: 'Email the client',
    };
  }
  if (actionId === 'work-note') {
    return {
      field: 'work_notes',
      clientVisible: false,
      verb: 'Post work note',
      confirm: 'Post work note',
    };
  }
  return null;
}

/** The note text, minus one wrapping fence the model sometimes adds. */
export function plainNote(text) {
  let note = String(text ?? '').trim();
  const fenced = note.match(/^```[a-z0-9]*\n([\s\S]*?)\n```$/i);
  if (fenced) note = fenced[1].trim();
  return note;
}

/**
 * Reject a post before it ever touches the page.
 * `field` is only `comments` or `work_notes`. A missing ticket number stops the call.
 */
export function postRequest({ field, text, expectNumber } = {}) {
  const note = plainNote(text);
  if (!note) return { ok: false, reason: 'empty-note' };
  if (field !== 'comments' && field !== 'work_notes') return { ok: false, reason: 'unknown-message' };
  const number = String(expectNumber ?? '').trim();
  if (!number) return { ok: false, reason: 'no-ticket' };
  return { ok: true, field, text: note, expectNumber: number };
}

/** One result from a multi-frame injection. Frames without the form report `no-form`. */
export function choosePostResult(entries) {
  const acted = [];
  for (const entry of entries || []) {
    const result = entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'result')
      ? entry.result
      : entry;
    if (!result || typeof result !== 'object') continue;
    if (result.reason === 'no-form') continue;
    acted.push(result);
  }
  if (!acted.length) return { ok: false, reason: 'no-form' };
  return acted.find((result) => result.ok) || acted[0];
}

/* eslint-disable no-undef */
export async function postJournalInPage({ field, text, expectNumber } = {}) {
  const gf = window.g_form;
  if (!gf || typeof gf.getUniqueValue !== 'function' || typeof gf.getValue !== 'function') {
    return { ok: false, reason: 'no-form' };
  }

  try {
    const table = typeof gf.getTableName === 'function' ? String(gf.getTableName() || '') : '';
    const sysId = String(gf.getUniqueValue() || '');
    const number = String(gf.getValue('number') || '').trim();
    if (field !== 'comments' && field !== 'work_notes') return { ok: false, reason: 'unknown-message' };
    if (!/^[a-z][a-z0-9_]*$/i.test(table)) return { ok: false, reason: 'no-form' };
    if (!/^[0-9a-f]{32}$/i.test(sysId)) return { ok: false, reason: 'not-saved', number };
    if (expectNumber && number !== String(expectNumber).trim()) {
      return { ok: false, reason: 'wrong-ticket', number };
    }
    if (!number) return { ok: false, reason: 'not-saved' };

    let tok = '';
    try { tok = window.g_ck || ''; } catch { tok = ''; }
    if (!tok) {
      try { tok = window.parent?.g_ck || ''; } catch { tok = ''; }
    }
    if (!tok) return { ok: false, reason: 'no-session' };

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-UserToken': tok,
    };
    const wrote = await fetch(`/api/now/table/${table}/${sysId}?sysparm_fields=number`, {
      method: 'PATCH',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({ [field]: text }),
    });
    const body = await wrote.json().catch(() => null);
    if (!wrote.ok || body?.error) return { ok: false, reason: 'post-failed', status: wrote.status };

    let confirmed = false;
    try {
      const read = await fetch(
        `/api/now/table/${table}?sysparm_query=${encodeURIComponent(`number=${number}`)}&sysparm_fields=${field}&sysparm_display_value=all&sysparm_limit=1`,
        { headers: { Accept: 'application/json', 'X-UserToken': tok }, credentials: 'same-origin' },
      );
      const rows = (await read.json())?.result;
      const raw = Array.isArray(rows) && rows.length === 1 ? rows[0]?.[field] : '';
      const landed = String(raw?.display_value || raw || '').replace(/\s+/g, ' ');
      const needle = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      confirmed = Boolean(needle) && landed.includes(needle);
    } catch {
      confirmed = false;
    }

    // The activity stream does not notice a Table API write until the form reloads.
    setTimeout(() => location.reload(), 400);
    return { ok: true, number, field, confirmed };
  } catch {
    return { ok: false, reason: 'post-failed' };
  }
}
/* eslint-enable no-undef */
