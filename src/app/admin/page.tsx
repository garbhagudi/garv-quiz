import { platformStats } from "@/lib/queries";
import { sql } from "@/lib/db";
import { getAdminSession } from "@/lib/session";
import { Overview } from "./Overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default async function AdminHome() {
  const session = await getAdminSession();

  const [stats, organizations, entries] = await Promise.all([
    platformStats(),
    sql`
      SELECT s.id, s.slug, s.name, s.city, s.is_open, s.event_date, s.created_at,
             (SELECT count(*)::int FROM participants p
               WHERE p.organization_id = s.id AND p.is_deleted = false)     AS registered,
             (SELECT count(*)::int FROM attempts a
               WHERE a.organization_id = s.id AND a.status = 'completed'
                 AND a.is_deleted = false)                                  AS completed
        FROM organizations s
       WHERE s.is_deleted = false
       ORDER BY s.created_at DESC
       LIMIT 8`,
    sql`
      SELECT p.name, p.phone, s.name AS organization, s.id AS organization_id,
             a.score, a.max_score, a.submitted_at
        FROM attempts a
        JOIN participants p ON p.id = a.participant_id
        JOIN organizations s      ON s.id = a.organization_id
       WHERE a.status = 'completed'
         AND a.is_deleted = false AND p.is_deleted = false AND s.is_deleted = false
       ORDER BY a.submitted_at DESC
       LIMIT 10`,
  ]);

  return (
    <Overview
      firstName={(session?.name ?? "there").split(" ")[0]}
      stats={stats}
      organizations={organizations as never}
      entries={entries as never}
    />
  );
}
