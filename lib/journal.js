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

/**
 * The markers the companion asks for around a postable note. Only the text
 * between them is ever posted; whatever the model says to the analyst goes
 * outside them and stays in the panel.
 */
export const NOTE_OPEN = '[[NOTE]]';
export const NOTE_CLOSE = '[[/NOTE]]';

/**
 * Appended to a Reply or Work note question. It belongs to the companion, not
 * to the recipe: the recipe says what to write, this says how to hand it back
 * so that only the note reaches ServiceNow.
 */
export function postingInstruction(spec) {
  if (!spec) return '';
  const who = spec.clientVisible
    ? 'the client reads it in an email from ServiceNow'
    : 'it is an internal work note other analysts read in the activity stream';
  return [
    '',
    `Format: put the ${spec.clientVisible ? 'reply' : 'work note'} between a line that says ${NOTE_OPEN} and a line that says ${NOTE_CLOSE}.`,
    `The text between them is posted to the ticket exactly as written, and ${who}. So inside the markers:`,
    '- plain text only: no Markdown, no asterisks, no # headings, no tables, no code formatting',
    '- no title or label such as "Work note" or "Draft reply", and no "---" separators',
    '- nothing addressed to me, such as an introduction, "Here is the draft", or "Let me know if you want changes"',
    `Anything you want to tell me goes after ${NOTE_CLOSE}, and is never posted.`,
  ].join('\n');
}

const META_LEAD = /^(here('s| is| are)|below is|this is (the|a|your) (draft|reply|note|work note)|i('ve| have) (drafted|written|put together)|sure[,!.]|okay[,!.]|ok[,!.]|certainly[,!.])/i;
// A closing line counts as an aside only when it talks about the draft itself.
// "Let me know if you have any questions." is part of a reply to the client.
const META_TAIL_START = /^(let me know|ready to|if you('d)?|would you like|want me to|i can|i('m| am) happy|happy to|should i|do you want|feel free)/i;
const META_TAIL_ABOUT = /\b(draft|paste|post(ing)?|work ?notes? field|changes?|edits?|adjust|tweak|revise|shorter|longer|tone|wording|version|me to)\b/i;
const LEAD_ABOUT = /\b(draft|work ?note|reply|note)\b[^.]*:\s*$/i;
const TITLE_LINE = /^[\s*_#>`=-]*(draft\s+)?(internal\s+)?(work\s*note|internal note|client reply|reply( to (the )?client)?|draft reply|draft|note)(\s*\([^)]*\))?[\s*_:`=-]*$/i;
const RULE_LINE = /^\s*([-*_=])(\s*\1){2,}\s*$/;

/** Markdown the model may still use, turned into the plain text a journal field shows. */
export function toPlainText(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let line of lines) {
    if (RULE_LINE.test(line)) continue;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table divider
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(' - ');
    }
    line = line
      .replace(/^(\s*)#{1,6}\s+/, '$1')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/(`+)([^`\n]+?)\1/g, '$2')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) =>
        label === href || href === `mailto:${label}` ? label : `${label} (${href})`)
      .replace(/[ \t]+$/, '');
    out.push(line);
  }
  return out.join('\n').replace(/^```[a-z0-9]*\n?|\n?```$/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Splits a drafted answer into the note to post and the aside meant for the
 * analyst. The markers win when the model used them. Otherwise the aside is
 * peeled off: a lead-in that introduces the draft, a sign-off that offers to
 * change it, "---" separators, and a title line such as "Work Note (Internal)".
 *
 * `source` says which way the note was found, so the panel can say when it
 * had to guess.
 */
export function splitNote(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return { note: '', aside: '', source: 'empty' };

  const open = raw.indexOf(NOTE_OPEN);
  const close = raw.indexOf(NOTE_CLOSE, open + NOTE_OPEN.length);
  if (open >= 0 && close > open) {
    const note = toPlainText(raw.slice(open + NOTE_OPEN.length, close));
    const aside = [raw.slice(0, open), raw.slice(close + NOTE_CLOSE.length)]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    return { note, aside, source: 'markers' };
  }

  let body = raw;
  const fenced = body.match(/^```[a-z0-9]*\n([\s\S]*?)\n```$/i);
  if (fenced) body = fenced[1].trim();

  const asides = [];
  // "intro --- note --- outro": the note is the longest block between rules.
  const blocks = body.split(/\n\s*([-*_])(?:\s*\1){2,}\s*\n/).filter((block, i) => i % 2 === 0);
  if (blocks.length > 1) {
    const longest = blocks.reduce((best, block, i) => (block.trim().length > blocks[best].trim().length ? i : best), 0);
    blocks.forEach((block, i) => { if (i !== longest && block.trim()) asides.push(block.trim()); });
    body = blocks[longest];
  }

  const lines = body.split('\n');
  // Lead-in lines that introduce the draft, until the first line of the note.
  while (lines.length) {
    const line = lines[0].trim();
    if (!line) { lines.shift(); continue; }
    if (TITLE_LINE.test(line)) { lines.shift(); continue; }
    if ((META_LEAD.test(line) && /:\s*$/.test(line)) || LEAD_ABOUT.test(line)) {
      asides.push(lines.shift().trim());
      continue;
    }
    break;
  }
  // Sign-off paragraphs addressed to the analyst.
  while (lines.length) {
    const line = lines[lines.length - 1].trim();
    if (!line) { lines.pop(); continue; }
    if (TITLE_LINE.test(line)) { lines.pop(); continue; }
    const bare = line.replace(/^[*_\s]+/, '');
    if (META_TAIL_START.test(bare) && META_TAIL_ABOUT.test(bare)) {
      asides.push(lines.pop().trim());
      continue;
    }
    break;
  }

  const note = toPlainText(lines.join('\n'));
  return { note, aside: asides.join('\n\n'), source: asides.length ? 'cleaned' : 'whole' };
}

/** The text that would be posted: the note alone, as plain text. */
export function plainNote(text) {
  return splitNote(text).note;
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
