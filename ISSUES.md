# Known issues

Scored Likelihood (1–10) × Impact (1–10). Items under 10 are logged and left alone.

## Logged

### Omnibox may still lose the user gesture — L3 × I3 = 9
- **Repro:** in Chrome, type the omnibox keyword, enter text, press Return. The omnibox event
  carries no tab, so the worker awaits a tab lookup before `sidePanel.open`.
- **Fix:** if the panel doesn't open, keep the last focused window id from `windows.onFocusChanged`
  and open with it synchronously.

### Light-mode kicker and options headings are low contrast — L4 × I2 = 8
- `.kicker` and options `h2` use `--scarlet-soft` (#f24a4f, 3.32:1 on light).
- **Fix:** use `--scarlet` (#cc0a21) for those in light mode.

### Prod/Test radios have no arrow-key movement — L3 × I2 = 6
- Tab reaches each one; arrow keys do nothing, unlike a native radio group.
- **Fix:** roving `tabindex` plus Left/Right handlers in `applyInstance`.

## Proposals (not bugs)

### One answer object in the side panel
Ten loose flags (`asking`, `stopped`, `posting`, `postArmed`, `answerPosted`, …) sit next to page
globals. Two of this round's bugs came from mixing them. Proposed:
`answer = { phase: idle|asking|streaming|answered|error|posting|posted, askId, url, ticket, actionId, note }`
with transitions in one place (~60 lines in `sidepanel.js`), tested from `test-flows.mjs`.

### Answer bar: one primary action
Post sits next to four equal round buttons. Move "Send to Menu" and "Send to Recipes" into one
"Send to…" menu so Post stays the obvious next step.

### `plainNote()` is unused in the post path
Still exported and covered by tests. Remove once nothing else imports it.
