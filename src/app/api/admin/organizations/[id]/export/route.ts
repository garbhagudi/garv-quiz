import * as XLSX from "xlsx";
import { sql } from "@/lib/db";
import { fail, route, requireAdmin, audit } from "@/lib/api";
import {
  getOrganizationById,
  allAttemptsRanked,
  organizationSummary,
  questionAnalysis,
} from "@/lib/queries";
import { formatMs } from "@/lib/quiz";
import { flattenQuestionText } from "@/lib/questionText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const stamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }) : "";

/**
 * GET /api/admin/organizations/:id/export
 *
 * Downloads the whole event as a four-sheet workbook. Unlike the original
 * build, exporting never deletes anything — clearing is a separate, explicitly
 * confirmed action, so a failed download can't lose the data.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const admin = await requireAdmin();
  const id = Number((await ctx.params).id);
  // A deleted event can still be exported, so its data can be recovered as a
  // spreadsheet even before anyone decides whether to restore it.
  const organization = await getOrganizationById(id, true);
  if (!organization) return fail("Event not found.", 404);

  const [summary, results, analysis, pending] = await Promise.all([
    organizationSummary(id),
    allAttemptsRanked(id),
    questionAnalysis(id),
    sql`
      SELECT p.name, p.phone, p.email, p.class_or_year, p.created_at,
             (SELECT count(*)::int FROM attempts a
               WHERE a.participant_id = p.id AND a.is_deleted = false)  AS attempts
        FROM participants p
       WHERE p.organization_id = ${id} AND p.is_deleted = false
         AND NOT EXISTS (SELECT 1 FROM attempts a
                          WHERE a.participant_id = p.id AND a.status = 'completed'
                            AND a.is_deleted = false)
       ORDER BY p.created_at DESC`,
  ]);

  const wb = XLSX.utils.book_new();

  /* ------------------------------- Results ------------------------------- */
  const resultRows = results.map((r) => ({
    Rank: r.rank,
    Name: r.name,
    Mobile: r.phone,
    Email: r.email,
    "Class / Year": r.class_or_year,
    Score: r.score,
    "Out of": r.max_score,
    Correct: r.correct_count,
    Questions: r.question_count,
    "Accuracy %": r.question_count
      ? Math.round((r.correct_count / r.question_count) * 1000) / 10
      : 0,
    // The rank turns on these two after score and accuracy, so they lead.
    Time: formatMs(r.server_ms),
    "Time (ms)": r.server_ms,
    "Best streak": r.best_streak,
    "Answer time": formatMs(r.answer_ms),
    "Answer time (ms)": r.answer_ms,
    "Total time": formatMs(r.elapsed_ms),
    Attempt: r.attempts_by_student > 1 ? `${r.attempt_no} of ${r.attempts_by_student}` : "1",
    Submitted: stamp(r.submitted_at),
  }));
  const wsResults = XLSX.utils.json_to_sheet(
    resultRows.length ? resultRows : [{ Rank: "", Name: "No entries yet" }],
  );
  wsResults["!cols"] = [
    { wch: 6 }, { wch: 26 }, { wch: 13 }, { wch: 28 }, { wch: 14 },
    { wch: 7 }, { wch: 7 }, { wch: 8 }, { wch: 10 }, { wch: 11 },
    { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 22 },
  ];
  wsResults["!freeze"] = { xSplit: 0, ySplit: 1 };
  if (resultRows.length) {
    wsResults["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { c: 0, r: 0 },
        e: { c: 14, r: resultRows.length },
      }),
    };
  }
  XLSX.utils.book_append_sheet(wb, wsResults, "Results");

  /* -------------------------- Question analysis -------------------------- */
  const analysisRows = analysis.map((a, i) => ({
    "#": i + 1,
    // A spreadsheet cell is one line, so a question that carries a bullet list
    // is flattened with its bullets kept as "• " markers.
    Question: flattenQuestionText(a.question_text),
    "Correct answer": a.correct_text,
    Asked: a.asked,
    "Got it right": a.got_right,
    "% correct": a.pct_correct,
    "Average time": formatMs(a.avg_ms),
  }));
  const wsAnalysis = XLSX.utils.json_to_sheet(
    analysisRows.length ? analysisRows : [{ "#": "", Question: "No answers recorded yet" }],
  );
  wsAnalysis["!cols"] = [{ wch: 4 }, { wch: 70 }, { wch: 45 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsAnalysis, "Question Analysis");

  /* ---------------------------- Did not finish --------------------------- */
  const pendingRows = (pending as unknown as Record<string, string | number>[]).map((p) => {
    const starts = Number(p.attempts ?? 0);
    return {
      Name: p.name,
      Mobile: p.phone,
      Email: p.email,
      "Class / Year": p.class_or_year,
      // Registered and walked away, or opened the quiz and never sent it back.
      // Worth separating: the first is a no-show, the second is a lost answer.
      "Got as far as": starts === 0 ? "Never started" : "Started, not submitted",
      "Attempts started": starts,
      Registered: stamp(String(p.created_at)),
    };
  });
  const wsPending = XLSX.utils.json_to_sheet(
    pendingRows.length ? pendingRows : [{ Name: "Everyone who registered finished" }],
  );
  wsPending["!cols"] = [
    { wch: 26 }, { wch: 13 }, { wch: 28 }, { wch: 14 },
    { wch: 22 }, { wch: 16 }, { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(wb, wsPending, "Did Not Finish");

  /* -------------------------------- Event -------------------------------- */
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ["Event", organization.name],
    ["Code", organization.slug],
    ["City", organization.city],
    ["Event date", organization.event_date ?? ""],
    ["Host contact", [organization.contact_name, organization.contact_phone].filter(Boolean).join(" · ")],
    [],
    ["Registered", summary.registered],
    ["Completed", summary.completed],
    // People, matching the Did Not Finish sheet. `in_progress` counts attempts,
    // and one student who starts twice would inflate it.
    ["Registered but never finished", summary.not_finished],
    ["Attempts still open", summary.in_progress],
    ["Average score", summary.avg_score],
    ["Top score", `${summary.top_score} of ${summary.out_of}`],
    ["Average answer time", formatMs(summary.avg_answer_ms)],
    [],
    ["Winner", results[0] ? `${results[0].name} — ${results[0].score} pts` : "—"],
    ["Runner-up", results[1] ? `${results[1].name} — ${results[1].score} pts` : "—"],
    ["Third", results[2] ? `${results[2].name} — ${results[2].score} pts` : "—"],
    [],
    ["Ranking rule", "Most points, then fastest total answering time, then earliest submission"],
    ["Exported", stamp(new Date().toISOString())],
    ["Exported by", `${admin.name} (${admin.email})`],
  ]);
  wsInfo["!cols"] = [{ wch: 24 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, "Event");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  await audit(admin, "organization.export", organization.slug, { rows: resultRows.length });

  const today = new Date().toISOString().slice(0, 10);
  const filename = `quiz-${organization.slug}-${today}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
