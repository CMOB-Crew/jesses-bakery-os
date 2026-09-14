/* ------------------------------------------------------------------ *
 * Which deliveries have no proof at all.
 *
 * The weekly audit in ./proof-audit answers "is every recorded proof still
 * there", in both directions, and answers it well. It cannot answer this
 * one, because a delivery with no photograph has no delivery_photos row to
 * inspect -- so eleven drops on a Tuesday with no photograph produce a clean
 * audit, and the only person who ever knew was the driver who saw the
 * message.
 *
 * Friday's commit d6b922c stopped a drawn placeholder being filed as proof.
 * That was right, and this is the other half of it: the honest nothing now
 * gets counted.
 *
 * WHY IT DOES NOT FAIL THE AUDIT
 *
 * proofAuditFailed() means "something is wrong with the proofs we hold" --
 * one is missing from the bucket, or its bytes changed. A drop with no
 * photograph is a different thing: evidence never captured, not evidence
 * lost. Folding it in would turn the weekly job red for a flat phone battery,
 * and an alarm that goes off for that stops being read -- which is the same
 * reasoning that keeps orphans out of the failure condition.
 *
 * So it reports separately and it reports EVERY WEEK, including clean ones.
 * A number that only appears when it is bad teaches nobody what normal looks
 * like.
 * ------------------------------------------------------------------ */

export type Uncovered = {
  delivery_id: string;
  delivery_date: string | null;
  store_id: string | null;
  store_name: string | null;
  status: string | null;
};

export type Coverage = {
  /** How many days back this looked. */
  window_days: number;
  /** Deliveries marked delivered in the window, excluding any from before
   *  photo capture existed at all -- those can never be covered. */
  delivered: number;
  /** Of those, how many carry no delivery_photos row of any kind. */
  uncovered: number;
  /** Whole percent, so a summary line does not carry six decimal places. */
  covered_pct: number | null;
  worst: Uncovered[];
};

/** Weekly job, so a fortnight leaves one missed run of slack. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Enough to act on, not so many that the log becomes the report. */
export const MAX_LISTED = 20;

type Sql = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/**
 * Both reads go through migration 101's security-definer functions, and that
 * is not a preference.
 *
 * delivery_photos has forced RLS and a scheduled call has no session, so a
 * plain "deliveries with no matching photo row" would match EVERY delivery --
 * a silent all-alarm rather than a silent all-clear, which is the same bug
 * wearing the opposite coat.
 */
export async function auditCoverage(opts: {
  sql: Sql;
  windowDays?: number;
}): Promise<Coverage> {
  const windowDays = Math.max(1, Math.trunc(opts.windowDays ?? DEFAULT_WINDOW_DAYS));
  const { sql } = opts;

  const [{ n: delivered }] = await sql<{ n: number }[]>`
    select public.jb_delivered_in_window(${windowDays})::int as n`;

  const rows = await sql<Uncovered[]>`
    select delivery_id, delivery_date, store_id, store_name, status
      from public.jb_deliveries_without_proof(${windowDays})`;

  const total = Number(delivered) || 0;
  const uncovered = rows.length;

  return {
    window_days: windowDays,
    delivered: total,
    uncovered,
    // Null rather than 100 when there were no deliveries at all. "100% of
    // nothing is covered" is the kind of true statement that reads as
    // reassurance, and there is nothing here to be reassured about.
    covered_pct: total === 0 ? null : Math.round(((total - uncovered) / total) * 100),
    worst: rows.slice(0, MAX_LISTED),
  };
}

/**
 * One line, printed on every run including clean ones.
 *
 * This is the whole point of 3.6: the gap has to be visible when it is small,
 * or nobody will recognise it when it is large.
 */
export function coverageSummary(c: Coverage): string {
  if (c.delivered === 0) {
    return `COVERAGE no deliveries in the last ${c.window_days} days, so nothing to photograph.`;
  }
  if (c.uncovered === 0) {
    return `COVERAGE all ${c.delivered} deliveries in the last ${c.window_days} days carry a proof.`;
  }
  return (
    `COVERAGE ${c.uncovered} of ${c.delivered} deliveries in the last ${c.window_days} days ` +
    `have NO proof of delivery (${c.covered_pct}% covered).`
  );
}

/** The drops themselves, named, so somebody can go and ask about them. */
export function coverageLines(c: Coverage): string[] {
  const out: string[] = [];
  for (const r of c.worst) {
    out.push(`NO PROOF ${r.delivery_date ?? "?"}  ${r.store_name ?? r.store_id ?? "?"}`);
  }
  if (c.uncovered > c.worst.length) {
    out.push(`         and ${c.uncovered - c.worst.length} more not listed.`);
  }
  return out;
}
