/**
 * Questions the panel can ask about the page in front of you.
 *
 * The live list is `browser-actions.json`, written by CTS Recipes from
 * recipes that opt in with `surfaces: ["chrome"]`. These copies are only the
 * fallback for the moment before that file exists. Triage stays byte-for-byte
 * the `prompt` of `triage-and-reply.json`. Reply, work note, and summarize
 * stay byte-for-byte that file's `browser_actions`.
 *
 * A page that is not a ticket keeps Summarize and Explain here. They are not
 * shelf jobs, and no recipe opts into `page_match: "page"`.
 */

export const TRIAGE_PROMPT =
  'Triage the ServiceNow ticket in the context below: what\'s wrong, what\'s missing, and whether it stays with CTS. Then draft (1) a plain-language reply to the client and (2) if it should move, a tech-to-tech escalation note naming the assignment group and what they need. Plain language, no em-dashes, no boilerplate filler (for example, no "ticket created for tracking purposes"). Drafts only.';

export const TICKET_ACTIONS = [
  {
    id: 'triage',
    label: 'Triage',
    primary: true,
    prompt: TRIAGE_PROMPT,
  },
  {
    id: 'reply',
    label: 'Reply',
    prompt:
      'Draft a plain-language reply to the client for the ServiceNow ticket in the context below. Acknowledge the issue, give the likely cause without internal jargon, say what happens next, and say what you need from them if anything. Close as {{CTS_ANALYST_NAME}}. Plain language, no em-dashes, no boilerplate filler (for example, no "ticket created for tracking purposes"). Draft only. Do not send it.',
  },
  {
    id: 'work-note',
    label: 'Work note',
    prompt:
      'Draft a ServiceNow work note for the ticket in the context below, written for CTS and not for the client. Include what is wrong, what has already been tried or ruled out, and the next step. If it should leave CTS, name the assignment group and the facts that group needs. Plain language, no em-dashes, no boilerplate filler (for example, no "ticket created for tracking purposes"). Draft only. Do not update ServiceNow.',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    prompt:
      'Summarize the ServiceNow ticket in the context below. Do not invent fields that are not there. Use this shape:\n\n[INC#####] — [short description]\n\nSummary: [1-2 sentences. What is wrong, who is affected, what has been tried.]\n\nKey facts:\n- Caller / Affected\n- Device / Location\n- State / Priority\n- Assigned\n- Opened / Updated\n\nWhere it stands: [the latest meaningful activity, and who the next move is waiting on.]',
  },
];

export const PAGE_ACTIONS = [
  {
    id: 'summarize-page',
    label: 'Summarize',
    primary: true,
    prompt:
      'Summarize the page in the context below in a few short paragraphs. Do not invent facts that are not in the context.',
  },
  {
    id: 'explain-page',
    label: 'Explain',
    prompt:
      'Explain the page in the context below. Say what it is, what matters, and what a reader should do next. Plain language. Do not invent facts that are not in the context.',
  },
];

function matchCatalog(page, catalog) {
  const actions = Array.isArray(catalog?.actions) ? catalog.actions : [];
  const kind = page?.kind === 'ticket' ? 'ticket' : 'page';
  return actions
    .filter((action) => {
      if (!action || typeof action.id !== 'string' || !action.id.trim()) return false;
      if (typeof action.label !== 'string' || !action.label.trim()) return false;
      if (typeof action.prompt !== 'string' || !action.prompt.trim()) return false;
      const match = typeof action.page_match === 'string' ? action.page_match.trim().toLowerCase() : '';
      return match === kind || match === 'any';
    })
    .map((action) => ({
      id: action.id,
      label: action.label,
      prompt: action.prompt,
      primary: action.primary === true,
      order: Number.isFinite(action.order) ? action.order : 0,
      page_match: typeof action.page_match === 'string' ? action.page_match.trim().toLowerCase() : '',
      recipe: typeof action.recipe === 'string' ? action.recipe : '',
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function usesCatalog(page, catalog) {
  return matchCatalog(page, catalog).length > 0;
}

export function actionsFor(page, catalog) {
  const matched = matchCatalog(page, catalog);
  if (matched.length) return matched;
  return page?.kind === 'ticket' ? TICKET_ACTIONS : PAGE_ACTIONS;
}

export function primaryAction(page, catalog) {
  const actions = actionsFor(page, catalog);
  return actions.find((action) => action.primary) ?? actions[0];
}
