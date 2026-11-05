/**
 * Waits for one ask to finish, whichever way the answer comes back.
 *
 * The answer used to travel only as the reply to one long message: panel →
 * worker → TerrierGPT tab, held open for as long as TerrierGPT writes. Safari
 * unloads an idle extension worker after about half a minute even with that
 * reply pending, and Chrome closes the channel if its worker restarts. The tab
 * finished the answer and the panel waited on a reply that could never arrive.
 *
 * Now the TerrierGPT tab also reports the final result, and a heartbeat, as
 * fresh messages. Those wake the worker, which writes them to session storage
 * keyed by the ask's id. The panel takes the first of: the direct reply, the
 * stored result, Stop, or silence long enough that the ask is lost.
 */

/** No word from the worker or the TerrierGPT tab for this long means the ask is lost. */
export const ASK_IDLE_MS = 90_000;
/** Longer than the tab's own 4-minute cap plus navigation and start-up. */
export const ASK_MAX_MS = 6 * 60_000;

export function newAskId() {
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A reply worth finishing on. `undefined` is what a dropped channel gives in
 * some Safari builds, so it means "keep waiting for the stored result".
 */
export function isUsableReply(reply) {
  return Boolean(reply) && typeof reply === 'object' && (reply.ok === true || typeof reply.reason === 'string');
}

/** Whether a session-storage entry (`askResult`, `askAlive`, `liveAnswer`) belongs to this ask. */
export function forAsk(entry, id) {
  return Boolean(entry && id && entry.id === id);
}

export function askTracker({ idleMs = ASK_IDLE_MS, maxMs = ASK_MAX_MS, now = () => Date.now() } = {}) {
  const started = now();
  let lastSign = started;
  let partial = '';
  let done = false;
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });

  const tickMs = Math.max(10, Math.min(1000, Math.floor(idleMs / 4)));
  const timer = setInterval(() => {
    const t = now();
    if (t - started > maxMs) finish({ ok: false, reason: 'generation-timeout', partial });
    else if (t - lastSign > idleMs) finish({ ok: false, reason: 'answer-lost', partial });
  }, tickMs);

  function finish(result) {
    if (done) return false;
    done = true;
    clearInterval(timer);
    resolve(result);
    return true;
  }

  return {
    promise,
    get done() {
      return done;
    },
    /** Any sign the ask is still moving: a worker stage, a tab heartbeat. */
    alive() {
      lastSign = now();
    },
    /** Streamed text, kept so a lost ask can still show what arrived. */
    text(value) {
      if (value) partial = value;
      lastSign = now();
    },
    /** The worker's direct reply. Ignored when the channel dropped. */
    reply(value) {
      return isUsableReply(value) ? finish(value) : false;
    },
    /** The result the TerrierGPT tab reported through storage. */
    settle(value) {
      return isUsableReply(value) ? finish(value) : false;
    },
    stop() {
      return finish({ ok: false, reason: 'generation-stopped', partial });
    },
  };
}
