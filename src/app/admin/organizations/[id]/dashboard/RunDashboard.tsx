"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "@/lib/client";
import { Notice, Spinner, Chip } from "@/components/admin/Ui";
import { RunPanel, type RunResult, type RunSummary } from "@/components/admin/RunPanel";
import {
  acceptingEntries,
  closesInMs,
  roundEnded,
  refreshMs,
  REFRESH_IDLE_MS,
} from "@/lib/eventWindow";

type LiveOrganization = {
  id: number;
  name: string;
  slug: string;
  city: string;
  is_open: boolean;
  closes_at: string | null;
};

type Live = { organization: LiveOrganization; summary: RunSummary; top: RunResult[] };

/**
 * The run screen on a URL of its own, so it can be opened on a second screen
 * and left there. Same panel the organization page shows under "Run the quiz".
 *
 * It polls rather than holding a socket open — a page that reconnects itself
 * after a flaky hall wifi blip is worth more here than instant updates — but it
 * polls deliberately:
 *
 *   - `/live` rather than the full detail route: one database round trip and a
 *     payload that does not grow with the size of the room, instead of five
 *     round trips carrying the whole results table.
 *   - every 5s while a round is running, every 20s when nothing is.
 *   - not at all while the tab is hidden, which is most of the day if somebody
 *     leaves it open. It refreshes the moment the tab comes back.
 */
export function RunDashboard({
  organizationId,
  canWrite,
}: {
  organizationId: number;
  canWrite: boolean;
}) {
  const [data, setData] = useState<Live | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);

  /**
   * @param manual a press of the button, which should show that it is working
   *   and report a failure. The background poll stays quiet: a blip on hall
   *   wifi is not worth an error banner across a screen somebody is presenting.
   */
  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      try {
        setData(await api<Live>(`/api/admin/organizations/${organizationId}/live`));
        setUpdatedAt(Date.now());
        setError("");
      } catch (e) {
        if (manual) setError(errText(e));
      } finally {
        if (manual) setRefreshing(false);
      }
    },
    [organizationId],
  );

  const live = data ? acceptingEntries(data.organization, now) : false;

  // Read inside the interval so changing pace never restarts the loop. Paced on
  // whether there is anything to watch — a round counting down or people still
  // answering — not on whether the event happens to be open.
  const paceRef = useRef(REFRESH_IDLE_MS);
  paceRef.current = data ? refreshMs(data.organization, data.summary.answering, now) : REFRESH_IDLE_MS;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!document.hidden) await load();
      timer = setTimeout(tick, paceRef.current);
    };
    void tick();

    // Coming back to the tab should show the truth at once, not in 20 seconds.
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // The clock is local; it does not need the network to keep counting down.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function startRound() {
    try {
      const res = await api<{ organization: { closes_at: string | null } }>(
        `/api/admin/organizations/${organizationId}`,
        { method: "PATCH", body: { startRound: true } },
      );
      const left = closesInMs(res.organization);
      setNotice(
        left === null
          ? "Entries are open. This set has no time limit, so close them yourself when you are done."
          : `Round started — entries close in ${Math.round(left / 60000)} minutes.`,
      );
      void load();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function closeEntries() {
    try {
      await api(`/api/admin/organizations/${organizationId}`, {
        method: "PATCH",
        body: { isOpen: false },
      });
      setNotice("Entries are now closed.");
      void load();
    } catch (e) {
      setError(errText(e));
    }
  }

  if (!data && !error) return <Spinner label="Loading…" />;
  if (!data)
    return (
      <>
        <Notice tone="warn">{error}</Notice>
        <button className="btn-ghost btn-sm" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? "Trying…" : "Try again"}
        </button>
      </>
    );

  const s = data.organization;

  return (
    <div className="mx-auto w-full max-w-[560px]">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-[22px] font-bold leading-tight text-plum">{s.name}</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Code <code className="rounded bg-petal px-1.5 py-0.5 text-plum">{s.slug}</code>
            {s.city ? ` · ${s.city}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Chip tone={live ? "good" : "neutral"}>{live ? "Live" : "Not running"}</Chip>
          <button
            className="btn-ghost btn-sm"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <Link href={`/admin/organizations/${s.id}`} className="linkish">
            Full results
          </Link>
        </div>
      </div>

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <RunPanel
        summary={data.summary}
        top={data.top}
        live={live}
        ended={roundEnded(s, now)}
        leftMs={closesInMs(s, now)}
        canWrite={canWrite}
        onStart={() => void startRound()}
        onClose={() => void closeEntries()}
        shareUrl={
          typeof window === "undefined" ? `/s/${s.slug}` : `${window.location.origin}/s/${s.slug}`
        }
      />

      {/* Worth saying on a screen left open all session: whether what you are
          looking at is current, or the wifi dropped ten minutes ago. */}
      <p className="mt-3 text-center text-[12px] text-muted">
        {updatedAt ? `Updated ${agoLabel(now - updatedAt)}` : "Updating…"}
      </p>
    </div>
  );
}

/** "just now" / "12s ago" / "3m ago" — vague on purpose, it is a reassurance. */
function agoLabel(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}
