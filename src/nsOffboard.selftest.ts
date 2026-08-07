/** Offline tests for the orphan-sweep planner — including the two abort guards, which are the
 *  highest-risk logic in the offboarding feature. pnpm test:offboard */
import { planOrphanSweep, planDomainSweep } from './nsOffboard.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const rt = (o: { id: string; ext: string; status?: number; branchid?: string }) => ({
  id: o.id, extension: o.ext, status: o.status ?? 1, branchid: o.branchid ?? 'B1',
});

// ── the abort guards ──────────────────────────────────────────────────────────
{
  const p = planOrphanSweep({ nsExtensions: null, rtUsers: [rt({ id: 'U1', ext: '100' })], branchid: 'B1', max: 200 });
  ok(p.status === 'abort' && p.reason === 'ns-list-unavailable', 'a FAILED NS list aborts — "could not read" must never look like "nobody exists"');
}
{
  const p = planOrphanSweep({ nsExtensions: [], rtUsers: [rt({ id: 'U1', ext: '100' })], branchid: 'B1', max: 200 });
  ok(p.status === 'abort' && p.reason === 'ns-list-empty', 'an EMPTY NS list aborts — otherwise one odd read deactivates an entire domain');
}

// ── the orphan set ────────────────────────────────────────────────────────────
{
  const p = planOrphanSweep({
    nsExtensions: ['100', '101'],
    rtUsers: [rt({ id: 'U1', ext: '100' }), rt({ id: 'U2', ext: '999' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 1 && p.orphans[0]!.ext === '999', 'a Ringotel record with no NS user is an orphan');
  ok(p.status === 'ok' && p.scanned === 2, 'scanned counts the branch records considered');
}
{
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [rt({ id: 'U1', ext: '999', status: 0 })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 0, 'an already-INACTIVE record is not an orphan — nothing to free, and re-deactivating is pointless');
}
{
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [rt({ id: 'U9', ext: '999', branchid: 'OTHER' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 0, 'a record in ANOTHER branch is never this domain’s orphan — the org list spans branches');
}
{
  // Two records at one extension collapse to one deactivation target; deactivateAppOnly handles both.
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [rt({ id: 'U1', ext: '999' }), rt({ id: 'U2', ext: '999' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 1 && p.orphans[0]!.rtUserIds.length === 2, 'records are grouped by extension, carrying every id');
}
{
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [rt({ id: 'U1', ext: '901' }), rt({ id: 'U2', ext: '902' }), rt({ id: 'U3', ext: '903' })],
    branchid: 'B1', max: 2,
  });
  ok(p.status === 'ok' && p.orphans.length === 2 && p.truncated === true, 'the cap bounds a run and reports truncation — never a silent drop');
}
{
  // NS extensions arrive as strings or numbers depending on the record; both must match.
  const p = planOrphanSweep({
    nsExtensions: ['100', ' 101 '],
    rtUsers: [rt({ id: 'U1', ext: '101' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 0, 'extension comparison trims whitespace on the NS side');
}
{
  const p = planOrphanSweep({ nsExtensions: ['100'], rtUsers: [{ extension: '999', branchid: 'B1', status: 1 }], branchid: 'B1', max: 200 });
  ok(p.status === 'ok' && p.orphans.length === 0, 'a record with no id is skipped — there is nothing to deactivate');
}

// ── case-insensitive membership (fix-wave F2) ──────────────────────────────────
{
  // NS "100A" and an operator-entered Ringotel "100a" are the same user by a spelling difference, not an
  // orphan. Case-sensitive comparison here was a perpetual deactivate loop: the sweep would plan it as an
  // orphan every hour, deactivateAppOnly would find and deactivate it, and reactivation writes the record
  // straight back.
  const p = planOrphanSweep({
    nsExtensions: ['100A'],
    rtUsers: [rt({ id: 'U1', ext: '100a' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 0, 'membership comparison is case-insensitive — a case-variant is known, not orphaned');
}
{
  // A genuine orphan still keeps its ORIGINAL Ringotel casing in the emitted entry — deactivateAppOnly
  // matches via `usersForExt`, which this fix deliberately leaves untouched (case-sensitive).
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [rt({ id: 'U1', ext: '999XYZ' })],
    branchid: 'B1', max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 1 && p.orphans[0]!.ext === '999XYZ', 'a genuine orphan keeps its original Ringotel casing in the emitted entry, not lowercased');
}

// ── attached secondaries are never swept ──────────────────────────────────────
{
  const p = planOrphanSweep({
    nsExtensions: ['100'],
    rtUsers: [
      { id: 'S1', extension: '900', branchid: 'B1', status: 2, userid: 'P1' }, // attached secondary, ext absent from NS
      { id: 'U1', extension: '901', branchid: 'B1', status: 1 },               // ordinary orphan
    ],
    branchid: 'B1',
    max: 200,
  });
  ok(p.status === 'ok', 'sweep plans normally alongside a secondary');
  const exts = p.status === 'ok' ? p.orphans.map((o) => o.ext) : [];
  ok(!exts.includes('900'), 'sweep: an attached secondary is NEVER an orphan — its primary owns the seat');
  ok(exts.includes('901'), 'sweep: an ordinary orphan beside a secondary is still swept');
}
{
  // The SAME guard, but with the status predicate unable to save it: `status: 1` (active) is exactly
  // the status an ordinary orphan has, so if `userid != null` were not itself excluded, this record
  // would be planned for deactivation — breaking a live user whose extension exists perfectly well,
  // just not attached to it directly, because its app login is shared with a primary on another
  // connection. The pre-existing `status !== 1` fixture above (status: 2) passes even with the
  // `userid` guard deleted, since that line already excludes it for an unrelated reason — this one
  // does not have that escape hatch.
  const p = planOrphanSweep({
    nsExtensions: ['100'], // the secondary's extension ('900') is absent from NS, same as a real orphan
    rtUsers: [{ id: 'S2', extension: '900', branchid: 'B1', status: 1, userid: 'P1' }],
    branchid: 'B1',
    max: 200,
  });
  ok(p.status === 'ok' && p.orphans.length === 0,
     'sweep: an ACTIVE attached secondary (status: 1) is still never an orphan — the userid guard alone must exclude it');
}

// ── the per-DOMAIN cap is shared across connections ────────────────────────────
{
  const nsExtensions = ['100'];
  const rtUsers = [
    { id: 'a', extension: '901', branchid: 'B1', status: 1 },
    { id: 'b', extension: '902', branchid: 'B1', status: 1 },
    { id: 'c', extension: '903', branchid: 'B2', status: 1 },
  ];

  // Budget of 2 across TWO connections: B1 consumes both, B2 gets none and is reported truncated.
  const plans = planDomainSweep({ nsExtensions, rtUsers, branchids: ['B1', 'B2'], max: 2 });
  const total = plans.reduce((n, p) => n + (p.plan.status === 'ok' ? p.plan.orphans.length : 0), 0);
  ok(total === 2, 'sweep cap: a domain with 2 connections deactivates at most `max` in total, not max PER connection');
  ok(plans.some((p) => p.plan.status === 'ok' && p.plan.truncated), 'sweep cap: exhausting the budget reports truncation');

  // A generous budget sweeps everything on both connections.
  const all = planDomainSweep({ nsExtensions, rtUsers, branchids: ['B1', 'B2'], max: 200 });
  const every = all.flatMap((p) => (p.plan.status === 'ok' ? p.plan.orphans.map((o) => o.ext) : [])).sort();
  ok(every.join(',') === '901,902,903', 'sweep: every connection is swept when the budget allows');

  // An abort on the domain-wide NS read must stop EVERY connection, not just the first.
  const aborted = planDomainSweep({ nsExtensions: null, rtUsers, branchids: ['B1', 'B2'], max: 200 });
  // Assert the REASON, not just that it aborted. Degrading a failed read to `[]` still aborts, via
  // planOrphanSweep's own empty-list guard — so a status-only assertion cannot tell the two apart and
  // would pass with the failed-read propagation removed entirely.
  ok(aborted.every((p) => p.plan.status === 'abort' && p.plan.reason === 'ns-list-unavailable'),
     'sweep: a failed NS read aborts every connection AS a read failure — the list is domain-wide');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
