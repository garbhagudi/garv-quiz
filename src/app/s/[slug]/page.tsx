import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { sql } from "@/lib/db";
import { getOrganizationBySlug } from "@/lib/queries";
import { Stage } from "@/components/Stage";
import { acceptingEntries } from "@/lib/eventWindow";
import { QuizFlow } from "./QuizFlow";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const organization = await getOrganizationBySlug((await params).slug);
  return { title: organization ? `${organization.name} - Quiz Challenge` : "Quiz Challenge" };
}

export default async function OrganizationPage({ params }: Props) {
  const { slug } = await params;
  const organization = await getOrganizationBySlug(slug);
  if (!organization) notFound();

  const [counts] = (await sql`
    SELECT
      (SELECT count(*)::int FROM questions
        WHERE set_id = ${organization.question_set_id}
          AND is_active = true AND is_deleted = false)                     AS total,
      (SELECT count(*)::int FROM attempts
        WHERE organization_id = ${organization.id}
          AND status = 'completed' AND is_deleted = false)                 AS played,
      -- The whole-quiz limit, so the landing page can promise the real number
      -- rather than an estimate that would contradict the rules screen.
      (SELECT time_limit_seconds FROM question_sets
        WHERE id = ${organization.question_set_id}
          AND is_deleted = false)                                          AS time_limit_seconds
  `) as unknown as { total: number; played: number; time_limit_seconds: number | null }[];

  const total = organization.question_set_id ? counts.total : 0;
  const asked = organization.question_count ? Math.min(organization.question_count, total) : total;

  return (
    <Stage eyebrow={[organization.name, organization.city].filter(Boolean).join(" · ")}>
      <QuizFlow
        slug={organization.slug}
        organizationName={organization.name}
        isOpen={acceptingEntries(organization) && asked > 0}
        hasQuestions={asked > 0}
        questionCount={asked}
        played={counts.played}
        timeLimitSeconds={counts.time_limit_seconds ?? null}
        requireEmail={organization.require_email}
        collectClass={organization.collect_class}
        prizeNote={organization.prize_note}
      />
    </Stage>
  );
}
