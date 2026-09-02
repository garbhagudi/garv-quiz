import { sql } from "./db";

/**
 * Nothing in this application is ever removed from the database. "Delete" sets
 * `is_deleted`, stamps who did it and when, and every read path filters those
 * rows out. The admin panel can list deleted rows and restore them, so a
 * mistyped confirmation on the night of an event is an inconvenience rather
 * than a loss.
 *
 * Deleting a parent marks its children too - an event's participants, a
 * participant's attempts - because a student whose event is gone should not
 * keep turning up in a cross-event people search.
 */

/**
 * The only tables this module will touch. Table names are never interpolated
 * from user input: a request supplies a key from this map, never a name.
 */
export const SOFT_DELETE_TABLES = {
  organization: "organizations",
  participant: "participants",
  attempt: "attempts",
  question: "questions",
  questionSet: "question_sets",
  adminUser: "admin_users",
} as const;

export type SoftDeleteKind = keyof typeof SOFT_DELETE_TABLES;

export const isSoftDeleteKind = (v: unknown): v is SoftDeleteKind =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(SOFT_DELETE_TABLES, v);

/** Human wording for messages and the activity log. */
export const KIND_LABEL: Record<SoftDeleteKind, string> = {
  organization: "event",
  participant: "participant",
  attempt: "attempt",
  question: "question",
  questionSet: "question set",
  adminUser: "team member",
};

export type Counts = Record<string, number>;

/* ------------------------------- deleting -------------------------------- */

/**
 * Every row removed in one action is stamped with the *same* `deleted_at`.
 * Restoring relies on it: a parent revives the children stamped at its own
 * moment and leaves alone anything deleted before that. Letting each statement
 * call now() would order the parent after its children by a few milliseconds
 * and the restore would quietly bring nothing back.
 */
const sweepStamp = () => new Date().toISOString();

async function mark(
  table: string,
  where: string,
  params: unknown[],
  adminId: number,
  at: string,
) {
  const rows = (await sql.query(
    `UPDATE ${table}
        SET is_deleted = true,
            deleted_at = $${params.length + 1}::timestamptz,
            deleted_by = $${params.length + 2}
      WHERE ${where} AND is_deleted = false
      RETURNING id`,
    [...params, at, adminId],
  )) as unknown as { id: number }[];
  return rows.length;
}

async function unmark(table: string, where: string, params: unknown[]) {
  const rows = (await sql.query(
    `UPDATE ${table}
        SET is_deleted = false, deleted_at = NULL, deleted_by = NULL
      WHERE ${where} AND is_deleted = true
      RETURNING id`,
    params,
  )) as unknown as { id: number }[];
  return rows.length;
}

/** Mark one event deleted, along with its participants and their attempts. */
export async function deleteOrganization(id: number, adminId: number): Promise<Counts> {
  const at = sweepStamp();
  const attempts = await mark("attempts", "organization_id = $1", [id], adminId, at);
  const participants = await mark("participants", "organization_id = $1", [id], adminId, at);
  const organizations = await mark("organizations", "id = $1", [id], adminId, at);
  return { organizations, participants, attempts };
}

/** Mark every entry for one event deleted, but leave the event itself live. */
export async function deleteOrganizationEntries(id: number, adminId: number): Promise<Counts> {
  const at = sweepStamp();
  const attempts = await mark("attempts", "organization_id = $1", [id], adminId, at);
  const participants = await mark("participants", "organization_id = $1", [id], adminId, at);
  return { participants, attempts };
}

/** Mark one participant deleted, along with every attempt they made. */
export async function deleteParticipant(id: number, adminId: number): Promise<Counts> {
  const at = sweepStamp();
  const attempts = await mark("attempts", "participant_id = $1", [id], adminId, at);
  const participants = await mark("participants", "id = $1", [id], adminId, at);
  return { participants, attempts };
}

export const deleteAttempt = (id: number, adminId: number) =>
  mark("attempts", "id = $1", [id], adminId, sweepStamp());

export const deleteQuestion = (id: number, adminId: number) =>
  mark("questions", "id = $1", [id], adminId, sweepStamp());

/** Mark a set deleted, along with the questions inside it. */
export async function deleteQuestionSet(id: number, adminId: number): Promise<Counts> {
  const at = sweepStamp();
  const questions = await mark("questions", "set_id = $1", [id], adminId, at);
  const sets = await mark("question_sets", "id = $1", [id], adminId, at);
  return { sets, questions };
}

export const deleteAdminUser = (id: number, adminId: number) =>
  mark("admin_users", "id = $1", [id], adminId, sweepStamp());

/* ------------------------------- restoring ------------------------------- */

async function deletedAt(table: string, id: number): Promise<string | null> {
  const rows = (await sql.query(
    `SELECT deleted_at FROM ${table} WHERE id = $1`,
    [id],
  )) as unknown as { deleted_at: string | null }[];
  return rows[0]?.deleted_at ?? null;
}

/**
 * Restoring a parent brings back the children that went with it, and only
 * those: a child deleted on its own beforehand carries an earlier timestamp,
 * so it stays deleted rather than reappearing unasked.
 */
export async function restore(kind: SoftDeleteKind, id: number): Promise<Counts> {
  if (kind === "organization") {
    const stamp = await deletedAt("organizations", id);
    const organizations = await unmark("organizations", "id = $1", [id]);
    if (!stamp) return { organizations };
    const participants = await unmark(
      "participants",
      "organization_id = $1 AND deleted_at >= $2::timestamptz",
      [id, stamp],
    );
    const attempts = await unmark(
      "attempts",
      "organization_id = $1 AND deleted_at >= $2::timestamptz",
      [id, stamp],
    );
    return { organizations, participants, attempts };
  }

  if (kind === "participant") {
    const stamp = await deletedAt("participants", id);
    const participants = await unmark("participants", "id = $1", [id]);
    if (!stamp) return { participants };
    const attempts = await unmark(
      "attempts",
      "participant_id = $1 AND deleted_at >= $2::timestamptz",
      [id, stamp],
    );
    return { participants, attempts };
  }

  if (kind === "questionSet") {
    const stamp = await deletedAt("question_sets", id);
    const sets = await unmark("question_sets", "id = $1", [id]);
    if (!stamp) return { sets };
    const questions = await unmark(
      "questions",
      "set_id = $1 AND deleted_at >= $2::timestamptz",
      [id, stamp],
    );
    return { sets, questions };
  }

  const table = SOFT_DELETE_TABLES[kind];
  return { [table]: await unmark(table, "id = $1", [id]) };
}

/**
 * A unique value is free to be taken again while its row sits deleted, so a
 * restore has to check the way an insert does. Returns a message explaining the
 * clash, or null when the restore can go ahead.
 */
export async function restoreBlockedReason(
  kind: SoftDeleteKind,
  id: number,
): Promise<string | null> {
  if (kind === "organization") {
    const rows = (await sql.query(
      `SELECT slug FROM organizations WHERE id = $1 AND is_deleted = true`,
      [id],
    )) as unknown as { slug: string }[];
    if (!rows[0]) return null;
    const clash = (await sql.query(
      `SELECT id FROM organizations
        WHERE lower(slug) = lower($1) AND is_deleted = false LIMIT 1`,
      [rows[0].slug],
    )) as unknown as { id: number }[];
    return clash.length
      ? `Another live event already uses the code "${rows[0].slug}". Rename that one first.`
      : null;
  }

  if (kind === "participant") {
    // Their mobile number needs no check: it is unique across every row,
    // deleted or not, so no live row can be holding it. Their email address is
    // a different matter - that rule covers live rows only, so somebody else
    // may have registered with it while this student sat deleted.
    const rows = (await sql.query(
      `SELECT organization_id, email FROM participants
        WHERE id = $1 AND is_deleted = true AND email <> ''`,
      [id],
    )) as unknown as { organization_id: number; email: string }[];
    if (!rows[0]) return null;
    const clash = (await sql.query(
      `SELECT name FROM participants
        WHERE organization_id = $1 AND lower(email) = lower($2)
          AND is_deleted = false
        LIMIT 1`,
      [rows[0].organization_id, rows[0].email],
    )) as unknown as { name: string }[];
    return clash.length
      ? `${clash[0].name} has since registered for this event with ${rows[0].email}.`
      : null;
  }

  if (kind === "adminUser") {
    const rows = (await sql.query(
      `SELECT email FROM admin_users WHERE id = $1 AND is_deleted = true`,
      [id],
    )) as unknown as { email: string }[];
    if (!rows[0]) return null;
    const clash = (await sql.query(
      `SELECT id FROM admin_users WHERE lower(email) = lower($1) AND is_deleted = false LIMIT 1`,
      [rows[0].email],
    )) as unknown as { id: number }[];
    return clash.length ? `${rows[0].email} already has a live account.` : null;
  }

  return null;
}
