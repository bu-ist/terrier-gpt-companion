/**
 * Which TerrierGPT instance the extension talks to, and the small amount of
 * preference state that goes with it.
 *
 * Both instances are declared in the manifest's host_permissions, so switching
 * between them never triggers a permission prompt.
 */

export const INSTANCES = {
  prod: {
    id: 'prod',
    label: 'TerrierGPT',
    short: 'Prod',
    origin: 'https://terriergpt.bu.edu',
  },
  test: {
    id: 'test',
    label: 'TerrierGPT Test',
    short: 'Test',
    origin: 'https://test.terriergpt-nonprod.bu.edu',
  },
};

/** Same default as the menu bar app: campus prod, Test only when you switch. */
export const DEFAULT_INSTANCE = 'prod';

export const DEFAULTS = {
  instance: DEFAULT_INSTANCE,
  /** Press Send for the user, instead of leaving the prompt in the composer to review. */
  autoSend: false,
  /** Start a fresh conversation instead of appending to whatever is on screen. */
  newChatPerSend: true,
  /** Upper bound on extracted page text, in characters. */
  maxPageChars: 40000,
  /** Saved agent to send to, or null for whatever the chat is already set to. */
  agentId: null,
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  // A stored instance id that no longer exists would leave us with no origin.
  if (!INSTANCES[stored.instance]) stored.instance = DEFAULT_INSTANCE;
  return stored;
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}
