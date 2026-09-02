/**
 * Whether an event is taking entries, and how long is left of its round.
 *
 * Two things decide it, and they are deliberately separate:
 *
 *   is_open    the switch a host throws by hand - Close entries, Reopen entries
 *   closes_at  the deadline a round was started with, or NULL for no deadline
 *
 * An event accepts entries only when the switch is on *and* the deadline is
 * either absent or still ahead. Nothing writes `is_open = false` when a deadline
 * passes: a past deadline already means closed to every reader, so there is no
 * job to run and no window where the database and the screen disagree.
 *
 * Pure, and free of any database import, so the browser decides this the same
 * way the server does - the admin panel ticks a countdown from the same rule
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
 * True for a timed event whose round nobody has started: the switch is on, but
 * there is no deadline, because only Start gives one.
 *
 * `closes_at` is null here exactly as it is on an untimed event, so the set's
 * own limit is the only thing that separates the two - which is why this takes
 * it as an argument rather than reading the event alone.
 */
export function roundNotStarted(o: EventWindow, timeLimitSeconds: number | null): boolean {
  return timeLimitSeconds !== null && o.is_open && !o.closes_at;
}

/**
 * The pause between the host pressing Start and the first question appearing,
 * so a room of phones counts down together instead of jumping.
 *
 * Paid for by the round rather than taken from it: Start sets the deadline this
 * much further out, so a five-minute quiz is still five minutes of answering.
 */
export const LEAD_IN_MS = 5_000;

/**
 * Milliseconds until the questions appear - the lead-in, counted down.
 *
 * Derived from the deadline rather than stored, because Start sets the deadline
 * to `now + LEAD_IN_MS + limit`: subtracting the limit gives the instant the
 * answering actually begins. Null when there is nothing to wait for.
 *
 * Returned to phones as a duration, never as a timestamp, so a phone with a
 * wrong clock still lands with the rest of the room.
 */
export function beginsInMs(
  o: EventWindow,
  timeLimitSeconds: number | null,
  now = Date.now(),
): number | null {
  if (timeLimitSeconds === null || !o.closes_at) return null;
  const at = new Date(o.closes_at).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - timeLimitSeconds * 1000 - now);
}

/**
 * True once the questions may be served: the event is taking entries, its round
 * has been started, and the lead-in has run out.
 *
 * Registering is deliberately allowed before this - that is what the waiting
 * room is - so the door and the questions are two different rules.
 */
export function questionsReady(
  o: EventWindow,
  timeLimitSeconds: number | null,
  now = Date.now(),
): boolean {
  if (!acceptingEntries(o, now)) return false;
  if (roundNotStarted(o, timeLimitSeconds)) return false;
  return (beginsInMs(o, timeLimitSeconds, now) ?? 0) <= 0;
}

/**
 * The one word for what an event is doing, for every screen that shows a badge.
 *
 * Worth having in one place: `is_open` on its own is never the answer, because
 * a deadline that has passed closes an event without touching that switch. The
 * organizations list said "Open" for an event whose round had finished, while
 * the event's own page offered to start a new one and students were turned
 * away - three screens, three different readings of the same row.
 *
 *   closed        the switch is off; nobody is getting in
 *   waiting-room  timed and open, but no round started: registering only
 *   live          a round is counting down
 *   over          the switch is on but the deadline has passed
 *   open          untimed and open, taking entries with nothing to run out
 */
export type EventStatus = "closed" | "waiting-room" | "live" | "over" | "open";

export function eventStatus(
  o: EventWindow,
  timeLimitSeconds: number | null,
  now = Date.now(),
): EventStatus {
  if (roundEnded(o, now)) return "over";
  if (!acceptingEntries(o, now)) return "closed";
  if (roundNotStarted(o, timeLimitSeconds)) return "waiting-room";
  return closesInMs(o, now) === null ? "open" : "live";
}

/* ---------------------------------------------------------------------------
   What the host may do next.

   These two decide the buttons on the run screen. They live here, next to the
   rules they are made of, because the run screen exists twice - the tab inside
   an event and the standalone dashboard - and every time this logic was written
   inline in both, the two drifted and a button went missing.
--------------------------------------------------------------------------- */

/**
 * May the host start a round?
 *
 * Timed: yes until a clock is actually ticking, so a closed event, a waiting
 * room and a finished round all still offer it. Untimed: there is no clock to
 * start, so Start simply means open, and it goes once the event is open.
 */
export function canStartRound(
  o: EventWindow,
  timeLimitSeconds: number | null,
  now = Date.now(),
): boolean {
  const counting = acceptingEntries(o, now) && closesInMs(o, now) !== null;
  return timeLimitSeconds !== null ? !counting : !acceptingEntries(o, now);
}

/**
 * May the host open the waiting room - doors open, clock not running?
 *
 * Only timed events have one, and only while the doors are not already open.
 * A finished round counts: the second round of the day wants the room filled
 * and waiting just as much as the first did.
 */
export function canOpenWaitingRoom(
  o: EventWindow,
  timeLimitSeconds: number | null,
  now = Date.now(),
): boolean {
  return timeLimitSeconds !== null && !acceptingEntries(o, now);
}

/**
 * True while a round is actually counting down - open, with a deadline still
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
 * still mid-quiz. An event that is merely open - or one nobody has started yet
 * - changes no faster than somebody can register, so polling it every five
 * seconds is all cost and no information.
 */
export const REFRESH_WATCHING_MS = 5_000;
export const REFRESH_IDLE_MS = 20_000;

export function refreshMs(o: EventWindow, answering: number, now = Date.now()): number {
  return roundRunning(o, now) || answering > 0 ? REFRESH_WATCHING_MS : REFRESH_IDLE_MS;
}

/**
 * True when the host left the switch on but the round has run out - the state
 * worth naming on screen, because "Closed" alone would look like somebody
 * pressed the button.
 */
export function roundEnded(o: EventWindow, now = Date.now()): boolean {
  return o.is_open && closesInMs(o, now) === 0;
}
