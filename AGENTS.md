# Agent conventions — terrier-gpt-companion

TerrierGPT Companion: a Manifest V3 Chrome extension that reads the current page (ServiceNow
tickets in particular), asks TerrierGPT (LibreChat), and shows the answer in a side panel.
The same source also builds the Safari extension carried by `../terrier-gpt-menubar`.

## Layout

| Path | What lives there |
|------|------------------|
| `manifest.json` | MV3 manifest, version source of truth |
| `service-worker.js` | Background worker |
| `content/` | Content scripts, including the Safari in-tab dock (`dock.js`) |
| `sidepanel/`, `options/` | Extension UI |
| `lib/` | Shared modules |
| `tools/` | Build, validation, tests, packaging (plain Node, no `package.json`) |
| `store/` | Chrome Web Store listing and privacy policy |

## Checks

Run before every commit:

```bash
node tools/validate.mjs      # manifest vs. disk, icons, CSP, MV3 pitfalls
node tools/test-prompt.mjs   # prompt composition, parity with the Swift app
node tools/test-page.mjs
node tools/test-pick.mjs
node tools/test-bridge.mjs
node tools/test-agents.mjs
node tools/test-flows.mjs
node tools/test-safari.mjs   # Safari build target
```

Build: `node tools/build.mjs chrome` or `node tools/build.mjs safari` (output in `dist/`, gitignored).
Store ZIP: `./tools/package.sh`.

## Rules

1. **Shared contract with the Mac app.** Prompt text, handoff envelopes, and `browser-actions.json`
   must stay compatible with `terrier-gpt-menubar` and CTS Recipes. `test-prompt.mjs` checks
   prompt parity; if you change a prompt, change the Swift side too or say why not.
2. **Safari is built from here.** Fix web bugs in this repo; the menu-bar app's Xcode build
   runs `node tools/build.mjs safari` against this clone. Do not copy built files into the
   menubar repo.
3. **LibreChat selectors** pin to `data-testid` attributes and must fail loudly, not silently.
4. **Tokens stay in memory.** The bearer token minted via `/api/auth/refresh` never leaves the
   function that uses it: no storage, no logging, no messages to other contexts.
5. **Permissions are a store review cost.** Do not add manifest permissions or host
   permissions without saying why; update `store/PRIVACY.md` if data handling changes.
6. Bump `manifest.json` `version` only for a release.

## Workflow

Team repo (`bu-ist`): work on a branch and open a PR. No real ticket content, names, or
screenshots of client data in tests, fixtures, or commits.
