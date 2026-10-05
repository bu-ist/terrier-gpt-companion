# TerrierGPT Companion

A Chrome extension that reads the page you are on — a ServiceNow ticket, or any other
page — asks [TerrierGPT](https://terriergpt.bu.edu), and shows the answer beside that page.

It is the browser half of the same idea as the
[TerrierGPT menu bar app](../../Xcode/TerrierGPTMenu): context goes in, an answer comes out.
The Mac app is better at everything outside the browser (Finder, Notes, Reminders, Calendar,
any app with selectable text). This is better at the web, and it works on Windows,
Linux and ChromeOS, which the Mac app never will.

## Why this exists alongside the Mac app

The menu-bar app reads a browser tab over AppleScript. That works, but reading the
*selection* needs the user to turn on "Allow JavaScript from Apple Events" by hand
(Safari: Develop → Developer Settings; Chromium: View → Developer), and reading the whole
article was never practical at all. An extension has the DOM already — no Automation
permission, no hidden menu item, no per-app TCC prompt.

The Mac app also deliberately never types into the chat box, because doing that over
AppleScript meant injecting JavaScript into markup it could not see. Here the injection
is ordinary first-class code pinned to LibreChat's own `data-testid` attributes, and it
fails loudly instead of silently.

| | Menu bar app | This extension |
|---|---|---|
| Read the current browser tab | AppleScript, needs an opt-in for selections | Native |
| Read a full article | Not practical | Native |
| Finder, Notes, Reminders, Calendar | Yes | No |
| Any app with selectable text | Services menu | No |
| Windows / Linux / ChromeOS | No | Yes |
| Put the prompt in the chat box | No, clipboard + ⌘V | Yes |

## What it does

The panel stays on the page you are reading. TerrierGPT answers in a background tab.

- **Page card** — title and host, or, on a classic ServiceNow form, the number, state, caller, and short description. The form is read from the `gsft_main` frame, not the navigator around it.
- **Actions** — on a ticket: Triage, Reply, Work note, and Summarize, from the CTS Recipes Tickets shelf (`triage-and-reply`, opted in with `surfaces: ["chrome"]`). Open CTS Recipes once so it can write that list. Until the list is there, the panel uses the same prompts baked in as a fallback and says so. On any other page: Summarize and Explain.
- **Answer** — rendered in the panel. Copy it, or continue the same conversation in the TerrierGPT tab. Asking does not switch away from the ticket, and it does not throw away the page text.
- **Context** — a selection on the page, a picked element, the clipboard, or a link, shown as capsules and included with the page. Pick highlights a block; one click adds it. The ticket fields still cover the usual ServiceNow form.
- **To Menu / To Recipes** — under an answer. To Menu writes a handoff file for the menu-bar app. To Recipes also drops that file in the CTS Recipes inbox and opens it. Both stay on this Mac. The menu app has to have been opened once so it can register the bridge.
- **Agents** — behind ⋯. Sync from an open TerrierGPT tab, or paste an agent's Copy link.
- **Right-click** — *Ask TerrierGPT about "…"* opens the panel and asks about the selection. *Open this page in TerrierGPT* opens the panel on the current page.
- **Omnibox** — type `tg`, then a space, then the question. The answer comes back in the panel.
- **Keyboard** — `Alt+Shift+T` opens the panel, `Alt+Shift+S` reads the page into it, `Alt+Shift+Y` asks with the primary action.
- **Prod | Test** — Prod is the default, matching the menu bar app. Test shows an amber TEST badge.

## Agents

Pick an agent under ⋯ and the question goes to that agent's conversation.

1. **Sync agents** reads agent links in the open TerrierGPT tab. It does not scan the page's storage, and it does not use the document title as the agent's name.
2. **Add agent** takes the link from the agent's **Copy link** button.
3. Saved agents live in Chrome sync storage. New chat, in Settings, still starts a fresh conversation for each question. An agent link already opens its own conversation.

## How the prompt gets there

The prompt is written into the TerrierGPT composer. It is not put in the URL. A ticket in the query string would sit in Chrome's history and in the server logs in front of TerrierGPT.

Asking uses a background tab the extension opened for this, so the tab you are working in stays put. The user's own TerrierGPT conversation is not navigated away. The content script waits until that background tab has finished loading before it types, because a ping during navigation is answered by the page that is about to be thrown away.

The assistant text is read from LibreChat's assistant turn (`.agent-turn`, or `data-testid="assistant-message"` when that build has it). The panel does not treat the prompt it just sent as the answer.

## Where it points

| Instance | Origin |
|---|---|
| TerrierGPT — **default** | `https://terriergpt.bu.edu` |
| TerrierGPT Test | `https://test.terriergpt-nonprod.bu.edu` |

Both are the same LibreChat build behind BU Login (OpenID). The extension never handles
credentials: it drives the tab you are already signed into.

## Site access

The extension ships with permission for the two TerrierGPT origins only — enough to place
a prompt in the composer. It has **no** standing access to the rest of the web.

Reading another page happens one of two ways:

- **Right-click, keyboard shortcut, or the extension icon** — Chrome's `activeTab` grants
  one-off access for that gesture, on that tab. Nothing is stored, nothing is granted.
- **A button in the side panel** — `activeTab` does not apply to clicks inside an extension
  page, so the panel asks for that one origin and says so. Granted sites are listed in
  Settings and can be revoked there.

## Install for the pilot

Until the unlisted store listing is live:

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick this folder

Once it is published unlisted, the store link installs and auto-updates it; the listing is
not searchable and not linked from anywhere public.

## Layout

```
terriergpt-companion/
├── manifest.json
├── service-worker.js          # context menus, commands, omnibox, capture + send
├── lib/
│   ├── config.js              # the two instances, settings
│   ├── prompt.js              # capture model + prompt composition (mirrors the Swift app)
│   ├── extract.js             # page extraction, ServiceNow fields, frame choice
│   ├── actions.js             # ticket and page questions
│   └── markdown.js            # answer rendering
├── content/composer.js        # the only persistent content script — TerrierGPT origins only
├── content/picker.js          # injected when Pick is pressed, then removed from the page flow
├── sidepanel/
├── options/
├── icons/
├── tools/
│   ├── generate_icons.py      # regenerates the PNGs, standard library only
│   ├── validate.mjs           # pre-load checks
│   ├── test-prompt.mjs        # prompt composition tests
│   └── package.sh             # builds the store ZIP
└── store/                     # listing copy, permission justifications, privacy policy
```

## Development

```sh
node tools/validate.mjs        # manifest vs. disk, icon dimensions, CSP, MV3 pitfalls
node tools/test-prompt.mjs     # prompt composition, incl. parity with the Swift app
node tools/test-page.mjs       # ticket formatting, frame choice, actions, markdown
node tools/test-pick.mjs       # element names for Pick
node tools/test-bridge.mjs     # native host handoff and page read
python3 tools/generate_icons.py
./tools/package.sh             # → dist/terriergpt-companion-<version>.zip
```

After editing, press the reload button on `chrome://extensions`. Content script changes
also need the TerrierGPT tab reloaded.

## Verified in Chrome

Loaded unpacked in Chrome 152 against the test instance. Confirmed working: the manifest
loads with no errors, the side panel renders and tracks the active tab, per-site permission
is requested for one origin and persists, page extraction produces a sized chip, the send
path finds and focuses the TerrierGPT tab, and a signed-out instance is reported as such.

The 0.2 panel (ticket card, background ask, answer beside the page) is covered by
`tools/test-page.mjs`. Pick and the menu bridge are covered by `tools/test-pick.mjs`
and `tools/test-bridge.mjs`. The 0.4 catalog (recipe opt-in, host `catalog`, and
the panel choosing those prompts) is covered by the same page and bridge tests.
None of this pass was exercised in Chrome, against a signed-in TerrierGPT session,
or against a live ServiceNow incident. Injection still needs that session.

Four bugs were found and fixed in that pass, all of them only visible in a live browser:

| Symptom | Cause |
|---|---|
| The "allow this site" banner stayed after access was granted | `.grant { display: flex }` outranks the UA's `[hidden] { display: none }`, so the `hidden` attribute did nothing. `tools/validate.mjs` now fails on this pattern |
| "The TerrierGPT tab did not respond in time" | A manifest-declared content script never reaches a tab that was already open. The service worker now injects it |
| Injecting could answer twice | A content script can arrive from the manifest *and* from that injection. Each load now stamps a token and only the newest listener answers — a plain flag would survive an extension reload and silence every listener |
| A signed-out instance reported "could not find the message box" | Sign-in was detected via LibreChat's `login-button` test id, which belongs to the email/password form. BU runs this instance SSO-only, so it never renders. Detected by route now |

## Known limits

- The composer selectors are pinned to LibreChat's `#prompt-textarea` and assistant turn.
  A LibreChat upgrade that renames them breaks injection. The panel reports
  `composer-not-found` rather than failing quietly.
- Asking always submits. The answer is what the panel is for. New chat lives in Settings.
- ServiceNow Agent Workspace (the Polaris UI) does not expose the classic form fields.
  The panel says so and falls back to the visible text. Classic `incident.do` is the path
  that reads number, caller, description, and the activity stream.
- Pages Chrome does not let extensions script — `chrome://`, the Web Store, the new tab
  page, PDFs in the built-in viewer — cannot be read.
- Extra context (selection, clipboard, links, picked elements) lives in session storage.
  Reloading the extension clears it. Asking does not.
- Pick reads the element under the pointer. It does not enter a shadow root, so Agent
  Workspace fields still fall back to the visible text of the block you click.
- To Menu and To Recipes need the TerrierGPT Menu app to have launched once on this Mac,
  so the native host is registered. The extension id stays pinned. This version does
  not change it, so a site you already allowed stays allowed.
- Ticket actions come from CTS Recipes. Open that app once after this update so it
  writes `browser-actions.json`. The host serves that file even when CTS Recipes is
  not running. Until the file exists, the panel keeps the built-in copies and says so.
  Reply closes as `{{CTS_ANALYST_NAME}}` until your Profile name is filled in.
- A recipe runs from the inbox only when that recipe has `"inbox": true` and its input
  contract matches the handoff. A plain answer is `terriergpt-answer`. A fenced contract
  in the answer is passed through.
