/**
 * Page extraction.
 *
 * `extractFromPage` is handed to `chrome.scripting.executeScript` as a `func`,
 * which serialises it and runs it in the page. It must be entirely
 * self-contained: no imports, no closure over anything in this module.
 *
 * ServiceNow's classic ticket form lives in the `gsft_main` iframe, so the
 * service worker runs this in every frame and then calls `pickExtraction`.
 * Formatting stays here, on the extension side, so the prompt is the ticket
 * rather than the navigator chrome.
 */

/* eslint-disable no-undef */
export function extractFromPage(maxChars) {
  const MAX = maxChars || 40000;

  function clean(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').trim();
  }

  function readControl(table, field) {
    const ids = [
      `sys_display.${table}.${field}`,
      `${table}.${field}`,
      `sys_readonly.${table}.${field}`,
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      let text = '';
      if (el.tagName === 'SELECT') {
        text = el.options[el.selectedIndex]?.text || '';
      } else if (el.value != null && String(el.value).trim()) {
        text = el.value;
      } else {
        text = el.textContent || '';
      }
      text = clean(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      if (!text || text === '-- None --' || text === 'None') continue;
      if (/^[0-9a-f]{32}$/i.test(text)) continue;
      return text;
    }
    return '';
  }

  function readMultiline(table, field) {
    const direct = readControl(table, field);
    if (direct) return direct;
    const frame = document.querySelector(`iframe[id*="${field}"]`);
    try {
      const text = clean(frame?.contentDocument?.body?.innerText || '').replace(/\n{3,}/g, '\n\n');
      return text;
    } catch {
      return '';
    }
  }

  function detectTable() {
    const known = ['incident', 'sc_req_item', 'sc_task', 'change_request', 'problem'];
    for (const table of known) {
      if (
        document.getElementById(`${table}.number`) ||
        document.getElementById(`sys_readonly.${table}.number`) ||
        document.getElementById(`sys_display.${table}.number`)
      ) {
        return table;
      }
    }
    const el = document.querySelector('[id$=".number"]');
    const match = el?.id?.match(/^(?:sys_readonly\.|sys_display\.)?([a-z][a-z0-9_]*)\.number$/);
    return match ? match[1] : null;
  }

  function readActivity() {
    const selectors = [
      '#activity_stream_entries',
      '#sn_form_inline_stream_entries',
      '.activity-stream-entries',
      '#activity_stream',
      '.activity_stream',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = clean(el?.innerText || '').replace(/\n{3,}/g, '\n\n');
      if (text.length > 40) return text.slice(0, 16000);
    }
    const blocks = Array.from(document.querySelectorAll('.sn-widget-textblock-body'))
      .map((el) => clean(el.innerText || ''))
      .filter(Boolean);
    return blocks.length ? blocks.join('\n\n').slice(0, 16000) : '';
  }

  function readTicket() {
    const table = detectTable();
    if (!table) return null;
    const ticket = {
      table,
      number: readControl(table, 'number'),
      state: readControl(table, 'state'),
      caller: readControl(table, 'caller_id') || readControl(table, 'requested_for') || readControl(table, 'opened_by'),
      shortDescription: readControl(table, 'short_description'),
      description: readMultiline(table, 'description'),
      assignmentGroup: readControl(table, 'assignment_group'),
      assignedTo: readControl(table, 'assigned_to'),
      configurationItem: readControl(table, 'cmdb_ci'),
      priority: readControl(table, 'priority'),
      impact: readControl(table, 'impact'),
      urgency: readControl(table, 'urgency'),
      category: readControl(table, 'category'),
      location: readControl(table, 'location'),
      opened: readControl(table, 'opened_at') || readControl(table, 'sys_created_on'),
      activity: readActivity(),
    };
    const hasStory = ticket.number || ticket.shortDescription || ticket.description || ticket.activity;
    return hasStory ? ticket : null;
  }

  const selection = clean(String(window.getSelection() || ''));
  const ticket = readTicket();

  let pageText = '';
  let truncated = false;
  if (!ticket) {
    const candidates = ['article', '[role="main"]', 'main', '#content', '.post', 'body'];
    let root = null;
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el && clean(el.innerText || '').length > 200) {
        root = el;
        break;
      }
    }
    root = root || document.body;
    if (root) {
      try {
        const clone = root.cloneNode(true);
        clone
          .querySelectorAll('script, style, noscript, nav, header, footer, aside, [aria-hidden="true"], svg')
          .forEach((el) => el.remove());
        clone.style.position = 'absolute';
        clone.style.left = '-99999px';
        clone.style.top = '0';
        document.body.appendChild(clone);
        pageText = clean(clone.innerText || '').replace(/\n{3,}/g, '\n\n');
        clone.remove();
      } catch {
        pageText = clean(root.innerText || '');
      }
    }
    if (pageText.length > MAX) {
      pageText = pageText.slice(0, MAX);
      truncated = true;
    }
  }

  return {
    title: document.title || location.hostname,
    url: location.href,
    host: location.hostname,
    selection,
    pageText,
    truncated,
    ticket,
  };
}

const FIELD_ORDER = [
  ['number', 'Number'],
  ['state', 'State'],
  ['caller', 'Caller'],
  ['priority', 'Priority'],
  ['impact', 'Impact'],
  ['urgency', 'Urgency'],
  ['category', 'Category'],
  ['assignmentGroup', 'Assignment group'],
  ['assignedTo', 'Assigned to'],
  ['configurationItem', 'Configuration item'],
  ['location', 'Location'],
  ['opened', 'Opened'],
  ['shortDescription', 'Short description'],
];

/** The prompt body for a classic ServiceNow form. Empty fields are left out. */
export function formatTicket(ticket, maxChars = 40000) {
  if (!ticket) return { body: '', truncated: false };
  const lines = [];
  for (const [key, label] of FIELD_ORDER) {
    const value = String(ticket[key] ?? '').trim();
    if (value) lines.push(`${label}: ${value}`);
  }
  const parts = [];
  if (lines.length) parts.push(lines.join('\n'));
  const description = String(ticket.description ?? '').trim();
  if (description) parts.push(`Description:\n${description}`);
  const activity = String(ticket.activity ?? '').trim();
  if (activity) parts.push(`Activity:\n${activity}`);
  let body = parts.join('\n\n').trim();
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }
  return { body, truncated };
}

function scoreFrame(frame) {
  let score = 0;
  if (frame.ticket?.number) score += 1000;
  if (frame.ticket?.shortDescription) score += 200;
  if (frame.ticket?.description) score += 100;
  if (frame.ticket?.activity) score += 50;
  score += Math.min(frame.pageText?.length ?? 0, 5000) / 100;
  score += Math.min(frame.selection?.length ?? 0, 500) / 50;
  return score;
}

/**
 * Picks the frame that actually holds the page.
 * A ServiceNow form frame wins over the navigator shell even when the shell
 * has more text. The selection can live in a different frame, so the longest
 * one is kept when the winning frame has none.
 */
export function pickExtraction(frames) {
  const list = (frames ?? []).filter((frame) => frame && (frame.ticket || frame.pageText || frame.selection));
  if (!list.length) return null;
  const best = [...list].sort((a, b) => scoreFrame(b) - scoreFrame(a))[0];
  const longest = [...list].sort((a, b) => (b.selection?.length ?? 0) - (a.selection?.length ?? 0))[0];
  const selection = String(best.selection || '').trim() || String(longest.selection || '').trim();
  return { ...best, selection };
}

export function isServiceNowHost(host) {
  return /(^|\.)service-now\.com$/i.test(host || '') || /servicenow/i.test(host || '');
}

/** What the panel and the prompt use, after the right frame has been chosen. */
export function presentPage(frame, maxChars = 40000) {
  if (!frame) return null;
  const formatted = frame.ticket ? formatTicket(frame.ticket, maxChars) : null;
  const useTicket = Boolean(formatted?.body);
  const body = useTicket ? formatted.body : frame.pageText || '';
  return {
    title: (useTicket && frame.ticket.shortDescription) || frame.title || frame.host || 'Page',
    url: frame.url || '',
    host: frame.host || '',
    kind: useTicket ? 'ticket' : 'page',
    serviceNow: isServiceNowHost(frame.host),
    ticket: useTicket ? frame.ticket : null,
    body,
    truncated: useTicket ? formatted.truncated : Boolean(frame.truncated),
    selection: String(frame.selection || '').trim(),
  };
}
