import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /api/media/:id — one uploaded picture.
 *
 * Public on purpose: the phone showing a question has no admin session, so the
 * picture cannot sit behind the admin guard. The random uuid is the only handle
 * and it is never listed anywhere a student can reach.
 *
 * The bytes for a given id never change — a re-upload creates a new row — so
 * the response is immutable and cached for a year. On the day of an event that
 * means one read per picture per phone, not one per question screen.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();

  let row: { mime: string; b64: string } | undefined;
  try {
    [row] = (await sql`
      SELECT mime, encode(bytes, 'base64') AS b64
        FROM media WHERE id = ${id}::uuid
       LIMIT 1`) as unknown as { mime: string; b64: string }[];
  } catch (e) {
    console.error("[media]", e instanceof Error ? e.message : e);
    return new Response("Unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (!row) return notFound();

  const body = Buffer.from(row.b64, "base64");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": row.mime,
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      // Belt and braces on top of the sniffing done at upload time: the browser
      // must not be free to decide this is something executable.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
