import { sql } from "./db";
import type { Organization } from "./types";

/**
 * Ranking rule, used identically in every query below:
 *   score DESC, answer_ms ASC, submitted_at ASC
 * Most points first, then the fastest total thinking time, then whoever
 * submitted earliest. Timing is measured per question, so a student who reads
 * the intro slowly isn't punished.
 */

/** The student-facing lookup: a deleted event's code stops working. */
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const rows = (await sql`
    SELECT * FROM organizations
     WHERE lower(slug) = lower(${slug}) AND is_deleted = false
     LIMIT 1`) as unknown as Organization[];
  return rows[0] ?? null;
}

/**
 * @param includeDeleted the admin panel passes true so a deleted event can
 *   still be opened, reviewed and restored.
 */
export async function getOrganizationById(
  id: number,
  includeDeleted = false,
): Promise<Organization | null> {
  const rows = (await sql`
    SELECT * FROM organizations
     WHERE id = ${id} AND (${includeDeleted} OR is_deleted = false)
     LIMIT 1`) as unknown as Organization[];
  return rows[0] ?? null;
}

/**
 * Resolve an event from whatever is in the URL: the numeric id the admin list
 * links with, or the code a host would type from memory. Lets a dashboard live
 * at /admin/organizations/garv/dashboard rather than at an id nobody knows.
 */
export async function getOrganizationByIdOrSlug(
  key: string,
  includeDeleted = false,
): Promise<Organization | null> {
  const asId = Number(key);
  if (Number.isInteger(asId) && asId > 0) {
    const byId = await getOrganizationById(asId, includeDeleted);
    if (byId) return byId;
  }
  const rows = (await sql`
    SELECT * FROM organizations
     WHERE lower(slug) = lower(${key}) AND (${includeDeleted} OR is_deleted = false)
     LIMIT 1`) as unknown as Organization[];
  return rows[0] ?? null;
}

/** Every completed attempt, newest-ranked first, with a per-student attempt number. */
export async function allAttemptsRanked(organizationId: number) {
  return (await sql`
    SELECT a.id, a.public_id, a.participant_id, a.score, a.max_score,
           a.correct_count, a.question_count, a.answer_ms, a.elapsed_ms,
           a.submitted_at, a.started_at, a.status, a.ip_hash,
           p.name, p.phone, p.email, p.class_or_year,
           ROW_NUMBER() OVER (
             ORDER BY a.score DESC, a.answer_ms ASC, a.submitted_at ASC
           )::int AS rank,
           ROW_NUMBER() OVER (
             PARTITION BY a.participant_id ORDER BY a.started_at ASC
           )::int AS attempt_no,
           COUNT(*) OVER (PARTITION BY a.participant_id)::int AS attempts_by_student
      FROM attempts a
      JOIN participants p ON p.id = a.participant_id
     WHERE a.organization_id = ${organizationId} AND a.status = 'completed'
       AND a.is_deleted = false AND p.is_deleted = false
     ORDER BY rank ASC`) as unknown as {
    id: number;
    public_id: string;
    participant_id: number;
    score: number;
    max_score: number;
    correct_count: number;
    question_count: number;
    answer_ms: number;
    elapsed_ms: number;
    submitted_at: string;
    started_at: string;
    status: string;
    ip_hash: string;
    name: string;
    phone: string;
    email: string;
    class_or_year: string;
    rank: number;
    attempt_no: number;
    attempts_by_student: number;
  }[];
}

export async function organizationSummary(organizationId: number) {
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM participants
         WHERE organization_id = ${organizationId} AND is_deleted = false)             AS registered,
      (SELECT count(*)::int FROM attempts WHERE organization_id = ${organizationId}
         AND status = 'completed' AND is_deleted = false)                              AS completed,
      -- Attempts still open right now: useful during an event ("three people
      -- are answering"), but it counts attempts, not people.
      (SELECT count(*)::int FROM attempts WHERE organization_id = ${organizationId}
         AND status = 'in_progress' AND is_deleted = false)                            AS in_progress,
      -- Still answering *right now*, for the live dashboard. An attempt is only
      -- counted while it could plausibly still be open: a student whose own
      -- countdown has expired is not coming back, and a host waiting on them
      -- would wait for ever. Untimed sets fall back to an hour, which is the
      -- same judgement made loosely rather than exactly.
      (SELECT count(*)::int FROM attempts a
        WHERE a.organization_id = ${organizationId} AND a.status = 'in_progress'
          AND a.is_deleted = false
          AND a.started_at > now() - (
                COALESCE(
                  (SELECT qs.time_limit_seconds FROM organizations o
                     JOIN question_sets qs ON qs.id = o.question_set_id
                    WHERE o.id = ${organizationId}),
                  3600
                )::text || ' seconds')::interval)                                 AS answering,
      -- People who registered and never finished a run. This is the number the
      -- panel shows and the "Did not finish" tab lists, so the two always agree.
      -- One student who starts three times is one person here and three above.
      (SELECT count(*)::int FROM participants p
        WHERE p.organization_id = ${organizationId} AND p.is_deleted = false
          AND NOT EXISTS (SELECT 1 FROM attempts a
                           WHERE a.participant_id = p.id AND a.status = 'completed'
                             AND a.is_deleted = false))                                AS not_finished,
      (SELECT COALESCE(round(avg(score)::numeric, 2), 0)::float FROM attempts
         WHERE organization_id = ${organizationId} AND status = 'completed'
           AND is_deleted = false)                                                     AS avg_score,
      (SELECT COALESCE(max(score), 0)::int FROM attempts
         WHERE organization_id = ${organizationId} AND status = 'completed'
           AND is_deleted = false)                                                     AS top_score,
      (SELECT COALESCE(max(max_score), 0)::int FROM attempts
         WHERE organization_id = ${organizationId} AND status = 'completed'
           AND is_deleted = false)                                                     AS out_of,
      (SELECT COALESCE(round(avg(answer_ms)::numeric, 0), 0)::int FROM attempts
         WHERE organization_id = ${organizationId} AND status = 'completed'
           AND is_deleted = false)                                                     AS avg_answer_ms
  `) as unknown as {
    registered: number;
    completed: number;
    in_progress: number;
    answering: number;
    not_finished: number;
    avg_score: number;
    top_score: number;
    out_of: number;
    avg_answer_ms: number;
  }[];
  return rows[0];
}

/** Per-question difficulty for one event: how many got it right, and how long they took. */
export async function questionAnalysis(organizationId: number) {
  return (await sql`
    SELECT ans.question_text,
           max(ans.correct_text)                                        AS correct_text,
           count(*)::int                                               AS asked,
           count(*) FILTER (WHERE ans.is_correct)::int                 AS got_right,
           round(100.0 * count(*) FILTER (WHERE ans.is_correct) / GREATEST(count(*), 1), 1)::float
                                                                        AS pct_correct,
           round(avg(ans.ms)::numeric, 0)::int                          AS avg_ms
      FROM answers ans
      JOIN attempts a ON a.id = ans.attempt_id
     WHERE a.organization_id = ${organizationId} AND a.status = 'completed'
       AND a.is_deleted = false
     GROUP BY ans.question_text
     ORDER BY pct_correct ASC`) as unknown as {
    question_text: string;
    correct_text: string;
    asked: number;
    got_right: number;
    pct_correct: number;
    avg_ms: number;
  }[];
}

/** Landing numbers for the admin home page. */
export async function platformStats() {
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM organizations WHERE is_deleted = false)       AS organizations,
      (SELECT count(*)::int FROM organizations
         WHERE is_open AND is_deleted = false)                                 AS organizations_open,
      (SELECT count(*)::int FROM participants WHERE is_deleted = false)        AS participants,
      (SELECT count(*)::int FROM attempts
         WHERE status = 'completed' AND is_deleted = false)                    AS attempts,
      (SELECT count(*)::int FROM questions
         WHERE is_active AND is_deleted = false)                               AS questions,
      (SELECT count(*)::int FROM question_sets
         WHERE NOT is_archived AND is_deleted = false)                         AS sets
  `) as unknown as {
    organizations: number;
    organizations_open: number;
    participants: number;
    attempts: number;
    questions: number;
    sets: number;
  }[];
  return rows[0];
}
