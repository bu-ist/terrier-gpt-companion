# Chrome Web Store Listing — TerrierGPT Companion

> Last Updated: 2026-10-05
> Visibility: **Unlisted** — pilot

## Store Listing

**Extension Name**
TerrierGPT Companion

**Short Description** (132 char max — this is 118)
Send the page you are reading, or just your selection, into TerrierGPT with an instruction attached.

**Detailed Description**

TerrierGPT Companion puts what you are reading into TerrierGPT without copying and pasting.

Select text on any page and right-click to ask about it. Or open the side panel, add the whole
page as context, write an instruction, and send. The text lands in the TerrierGPT message box,
where you can read it over before submitting.

What you can do:

Add the current page, your selection, or a link as context. Each item appears as a chip you can
switch in or out of the prompt, so you can send three sources and drop one without starting over.

Right-click a selection to ask about it directly, or add it to the context you are building up.

Type "tg" and a space in the address bar, then your question, to send it straight through.

Use Alt+Shift+T to open the panel, Alt+Shift+S to capture the page, and Alt+Shift+Y to send.

Send to a specific TerrierGPT agent instead of the default chat. Add an agent by pasting the
link from its Copy link button, and it stays in the list.

Switch between the TerrierGPT test and production instances from the panel.

How to use it:

1. Sign in to TerrierGPT in a tab as you normally would.
2. Browse to whatever you want to ask about. On a ServiceNow ticket, allow that site once.
3. Open the panel. Triage, Reply, Work note, and Summarize ask about the ticket.
   After you open CTS Recipes once, those buttons come from its Tickets shelf.
4. The answer stays in the panel. Continue in TerrierGPT only if you want the full chat.
5. Pick adds one element from the page as context. To Menu and To Recipes, under the
   answer, hand that answer to the TerrierGPT Menu app on this Mac.

About permissions:

This extension does not have standing access to the websites you visit. It can reach the
TerrierGPT site, which is how it places the prompt in the message box. For any other page, it
reads the content only at the moment you ask it to — through a right-click, a keyboard shortcut,
or a per-site permission you grant from the panel and can revoke in Settings.

Nothing you capture is sent to a server run by this extension. Asking writes the prompt into
the TerrierGPT tab you are signed into. To Menu and To Recipes write a handoff file on this
Mac for the TerrierGPT Menu app, and To Recipes can open CTS Recipes. There is no account
and no analytics.

This is an independent companion for Boston University's TerrierGPT service. It requires a BU
login to TerrierGPT itself.

**Category**
Productivity

**Single Purpose**
Sends web page content and text selections into the TerrierGPT chat interface as a prompt.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 | ⬜ Not created | Side panel with two chips and an instruction typed |
| Screenshot 2 | 1280×800 | ⬜ Not created | Right-click menu open on a selected paragraph |
| Screenshot 3 | 1280×800 | ⬜ Not created | The composed prompt sitting in the TerrierGPT message box |
| Screenshot 4 | 1280×800 | ⬜ Not created | Settings, showing the per-site access list |
| Small Promo Tile | 440×280 | ⬜ Not created | Optional for unlisted |

### Screenshot notes

Take these against the **test** instance so no real conversation content is published. Use a
public page as the captured source — a BU news article or a Wikipedia page — not anything from
a course site or an internal tool.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `sidePanel` | permissions | The extension's main interface is a side panel where the user collects context, writes an instruction, and sends it. |
| `contextMenus` | permissions | Adds "Ask TerrierGPT about …" and "Add … to TerrierGPT context" to the right-click menu, which is the primary way users capture a selection. |
| `storage` | permissions | Stores the user's own settings (which instance to use, whether to auto-send, page length cap) and holds captured context for the current browsing session. Nothing leaves the device. |
| `tabs` | permissions | Needed to find or open the user's TerrierGPT tab and bring it to the front, and to show the current page's title in the panel so the user can see what they are about to capture. Reading `tab.url` requires this permission. |
| `scripting` | permissions | Two uses: extracting text from the page the user asked to capture, and showing a brief confirmation toast after a right-click action so it is never silent. |
| `activeTab` | permissions | Lets a right-click, keyboard shortcut, or icon click read that one tab without the extension holding standing access to every site. This is what keeps broad host access optional rather than required. |
| `https://terriergpt.bu.edu/*` | host_permissions | The extension's whole purpose: placing the composed prompt into the TerrierGPT message box on this site. |
| `https://test.terriergpt-nonprod.bu.edu/*` | host_permissions | The same, for Boston University's non-production TerrierGPT instance, which this pilot targets by default. |
| `https://*/*`, `http://*/*` | optional_host_permissions | **Optional, never requested at install.** Asked for one origin at a time, from a button in the side panel, only when the user tries to capture a page from that site and explains why. Site buttons inside an extension panel do not qualify for `activeTab`, so this is the only way to support capturing from the panel. Granted sites are listed in Settings and can be revoked there. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No.

The extension has no backend. It transmits nothing to the developer or to any third party.
Captured page text is held in the browser's session storage and is written only into the
TerrierGPT tab the user is signed into, at the moment the user presses Send. Settings are stored
in Chrome's own sync storage.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | No | No | — | No |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | No | No | — | No |
| User activity | No | No | — | No |
| Website content | Handled locally, not collected | No — written only into the user's own TerrierGPT tab, by their action | Building the prompt the user chose to send | No |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** — ⬜ **Needs hosting before submission.**
Text is ready in `store/PRIVACY.md`. A GitHub Pages file or a BU-hosted page both work; the URL
just has to be publicly reachable and match the disclosures above.

## Distribution

**Visibility**: Unlisted
**Regions**: All regions

Unlisted means the listing does not appear in search or in category browsing. Anyone with the
link can install it, and installs update automatically. Suitable for a pilot; revisit before any
public listing.

## Developer Info

**Publisher Name** — ⬜ To confirm. If this is published under a BU-owned developer account rather
than a personal one, the account must be set up first; a group publisher also needs domain
verification.

**Contact Email** — ⬜ To confirm (a personal address becomes publicly visible on the listing; an
alias or a group address is preferable).

**Support URL / Email** — ⬜ To confirm.

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-09-22 | Agent shortcuts: send to a chosen TerrierGPT agent via its own deep link. No new permissions. First build: side panel, context menus, omnibox, keyboard commands, two-instance switching. Loaded unpacked in Chrome 152 and exercised against the test instance; four bugs found and fixed (see README). | Draft |

## Review Notes

### Before submitting

- [ ] Clear the pilot with whoever owns TerrierGPT at BU. The name and the branding are theirs,
      and the store listing is public even when the extension itself is unlisted.
- [ ] Confirm whether the developer account should be BU-owned rather than personal.
- [ ] Host the privacy policy and paste the URL above.
- [ ] Capture the four screenshots against the test instance.

### Known issues / limitations

- Agents are added by the user pasting a link, not listed automatically. This is a deliberate
  choice, not a gap: listing them would require the extension to obtain an API access token,
  which is out of scope for a UI helper. Worth stating plainly if a reviewer asks why there is
  no agent list.


- Prompt injection depends on LibreChat's `data-testid` attributes (`text-input`, `send-button`,
  `new-chat-button`). A LibreChat upgrade that renames them breaks injection. The failure is
  reported to the user as "Could not find the TerrierGPT message box" rather than being silent,
  but it needs a code change to fix. Re-test after every TerrierGPT upgrade.
- Chrome lists this extension under "Access requested" rather than "Full access" on an
  ordinary site, which is the intended posture and is worth pointing at if a reviewer asks.
- Reviewers may question the broad `optional_host_permissions`. The justification above is the
  answer: they are optional, never requested at install, asked for one origin at a time with an
  explanation, and revocable from Settings.

### Rejection history

None yet.
