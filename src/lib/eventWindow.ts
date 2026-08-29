/**
 * Whether an event is taking entries, and how long is left of its round.
 *
 * Two things decide it, and they are deliberately separate:
 *
 *   is_open    the switch a host throws by hand — Close entries, Reopen entries
 *   closes_at  the deadline a round was started with, or NULL for no deadline
 *
 * An event accepts entries only when the switch is on *and* the deadline is
 * either absent or still ahead. Nothing writes `is_open = false` when a deadline
 * passes: a past deadline already means closed to every reader, so there is no
 * job to run and no window where the database and the screen disagree.
 *
 * Pure, and free of any database import, so the browser decides this the same
 * way the server does — the admin panel ticks a countdown from the same rule
 * that /api/quiz/start turns a student away by.
 */

export type EventWindow = {
  is_open: boolean;
  /** ISO timestamp, or null when the round has no end of its own. */
  closes_at?: string | null;
};

/**
 * Milliseconds until the round ends; 0 once it has, and null when untimed.
 * Takes only the deadline, so it can also be asked of a bare response row that
 * carries nothing else.
 */
export function closesInMs(o: Pick<EventWindow, "closes_at">, now = Date.now()): number | null {
  if (!o.closes_at) return null;
  const at = new Date(o.closes_at).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/** True while new students may still register and start a run. */
export function acceptingEntries(o: EventWindow, now = Date.now()): boolean {
  if (!o.is_open) return false;
  const left = closesInMs(o, now);
  return left === null || left > 0;
}

/**
 * True while a round is actually counting down — open, with a deadline still
 * ahead. Not the same as accepting entries: an event left open with no time
 * limit takes entries indefinitely without any round running.
 */
export function roundRunning(o: EventWindow, now = Date.now()): boolean {
  const left = closesInMs(o, now);
  return o.is_open && left !== null && left > 0;
}

/**
 * How often the run screen should ask for fresh numbers.
 *
 * Fast only when there is something to watch: a round counting down, or people
 * still mid-quiz. An event that is merely open — or one nobody has started yet
 * — changes no faster than somebody can register, so polling it every five
 * seconds is all cost and no information.
 */
export const REFRESH_WATCHING_MS = 5_000;
export const REFRESH_IDLE_MS = 20_000;

export function refreshMs(o: EventWindow, answering: number, now = Date.now()): number {
  return roundRunning(o, now) || answering > 0 ? REFRESH_WATCHING_MS : REFRESH_IDLE_MS;
}

/**
 * True when the host left the switch on but the round has run out — the state
 * worth naming on screen, because "Closed" alone would look like somebody
 * pressed the button.
 */
export function roundEnded(o: EventWindow, now = Date.now()): boolean {
  return o.is_open && closesInMs(o, now) === 0;
}
