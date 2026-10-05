# Privacy Policy — TerrierGPT Companion

_Last updated: 5 October 2026 (0.4)_

## Summary

TerrierGPT Companion has no server. It collects nothing, transmits nothing to its developer,
and contains no analytics, tracking, or advertising code. Asking TerrierGPT stays in
your browser. Sending an answer to the menu-bar app, or a page read that app requests,
stays on this Mac.

## What the extension handles

**Page content you read.** When you ask about a page, the text needed for that question
(the ticket fields, or the visible article) is held in memory for the side panel. A selection,
clipboard item, or link you add is held in your browser's session storage. It is cleared when
you clear it, or when the browsing session ends. Asking does not delete it.

The prompt is written into the TerrierGPT message box. It is not placed in the page URL, so
ticket text is not added to Chrome's history by this extension.

**Pick.** Choosing an element reads that element's text into the same session storage as a
selection. It leaves the page when you leave pick mode.

**The menu bar app, when you ask it to.** To Menu and To Recipes send the answer to a helper
the TerrierGPT Menu app installed on this Mac. The helper writes a handoff file under
`~/Library/Application Support/TerrierGPTMenu/handoffs`. To Recipes also copies that file
into the inbox folder and opens CTS Recipes. When you capture the front tab from the menu
app, the app can ask this extension for the page text and the extension hands it back on
this Mac. The text is not sent to a server of this extension.

**The recipe catalog.** The panel asks that same helper for the labels and prompts
CTS Recipes wrote to `browser-actions.json` on this Mac. That list is prompts, not
the page you are reading. A copy is held in the browser's session storage until
the session ends. It is not sent to a server of this extension.

**Your settings.** Which TerrierGPT instance to use, whether to start a new conversation per
question, and the maximum page length. These are kept in Chrome's settings storage and sync
across your Chrome profile if you have Chrome Sync switched on. That syncing is Chrome's, not ours.

## Where captured text goes

Into a TerrierGPT tab in your browser, at the moment you ask. The extension writes the
prompt into the message box on `terriergpt.bu.edu` or `test.terriergpt-nonprod.bu.edu`.
The answer is read back from that tab into the side panel.

Into a handoff file on this Mac when you press To Menu or To Recipes, and back to the
TerrierGPT Menu app when that app asks for the front tab. Nowhere else.

Once the text is in TerrierGPT, Boston University's own terms and privacy statement govern it:

- [BU Digital Privacy Statement](https://www.bu.edu/policies/digital-privacy-statement/)
- [BU Acceptable Use of Computing Services Policy](https://www.bu.edu/policies/acceptable-use-of-computing-services-policy)

## Site access

The extension is installed with access to the two TerrierGPT sites only. It has no standing
access to any other website.

To read a page elsewhere, one of two things has to happen:

- You use a right-click menu item, a keyboard shortcut, or the extension icon. Chrome grants
  one-off access to that single tab for that single action. Nothing is stored or retained.
- You press a capture button in the side panel. Chrome does not extend one-off access to buttons
  inside an extension's own interface, so the extension asks for permission for that one site
  and tells you which. Sites you have allowed are listed under Settings, where you can revoke
  any of them at any time.

## Authentication

The extension never sees, stores, or handles your BU credentials. Signing in happens in the
TerrierGPT tab, with BU Login, exactly as it does without the extension.

## Children

The extension is intended for Boston University faculty, staff, and students, and is not
directed at children under 13.

## Changes

Material changes to this policy will be published with a new version of the extension and the
date above updated.

## Contact

<!-- Add the published contact address before submitting; it must match the one on the store
     listing. -->
