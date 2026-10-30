/**
 * Plain-English text for every failure code the extension can produce.
 *
 * The service worker shows these as a toast in the page; the side panel shows
 * them in its status line. One table so the two never drift apart.
 */

const REASONS = {
  'unsupported-page': 'TerrierGPT cannot read this kind of page.',
  'no-access': 'Allow access to this site first — the panel will ask.',
  'no-content': 'Nothing could be read from this page.',
  'empty-selection': 'Select some text first.',
  'empty-page': 'This page has no readable text.',
  'empty-prompt': 'There is nothing to send.',
  'composer-not-found': 'Could not find the TerrierGPT message box. The site may have changed.',
  'no-content-script': 'The TerrierGPT tab did not respond in time.',
  'unknown-message': 'Something went wrong.',
  exception: 'Something went wrong.',
  busy: 'TerrierGPT is still answering. Wait for it to finish.',
  'signed-out': 'TerrierGPT is signed out. Use Sign in with BU Login under the gear, then ask again.',
  'send-unavailable': 'Prompt is in the message box — press Send there.',
  'clipboard-empty': 'Clipboard is empty or has no readable text.',
  'clipboard-error': 'Could not read from clipboard.',
  'no-agents-found': 'No agents found in open TerrierGPT tab.',
  'agents-api': 'TerrierGPT did not return the agent list. Open TerrierGPT, sign in, and try again.',
  'generation-timeout': 'TerrierGPT took too long to answer.',
  'generation-stopped': 'Answer generation was cancelled.',
  'generation-failed': 'TerrierGPT encountered an error generating the response.',
  'bridge-missing': 'Open TerrierGPT Menu once so it can register the bridge, then try again.',
  'bridge-failed': 'The menu bridge did not answer. Open TerrierGPT Menu and try again.',
  'empty-note': 'There is no text to post.',
  'no-ticket': 'Open the ticket this draft belongs to, then post it.',
  'no-form': 'The ticket form is not open in this tab.',
  'not-saved': 'This form has no saved record yet. Save the ticket once, then post.',
  'wrong-ticket': 'This draft is for a different ticket than the one open in the tab.',
  'no-session': 'ServiceNow is not signed in on this tab.',
  'post-failed': 'ServiceNow did not accept the note.',
};

export function describe(reason) {
  return REASONS[reason] ?? 'Something went wrong.';
}
