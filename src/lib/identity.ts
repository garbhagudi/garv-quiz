/**
 * Deciding whether two registrations are the same student.
 *
 * The mobile number is the identity — one row per number per event, for ever.
 * The email address is unique per event as well, which leaves one genuinely
 * ambiguous case: the same address arriving with a different number. That is
 * either a student who mistyped their number and is now locked out of their own
 * quiz, or two students sharing an inbox, which the address rule exists to
 * prevent. Nothing in the request distinguishes them except the name.
 *
 * So the name is the tie-breaker: forgiving enough that a first name is enough
 * to be recognised, strict enough that somebody else's address does not let a
 * stranger through.
 */

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Forgiving name check: exact, or the first name alone, is enough. "asha" and
 * "Asha Rao" match; "Copycat C" and "Asha Rao" do not.
 */
export function nameMatches(given: string, stored: string): boolean {
  const g = norm(given);
  const s = norm(stored);
  if (!g) return false;
  return g === s || s.startsWith(g + " ") || g === s.split(" ")[0];
}
