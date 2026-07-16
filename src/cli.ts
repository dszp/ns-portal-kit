/**
 * Phase-1 spike CLI. Node-only entry point (fs/path live here, NOT in the resolver) so the
 * resolver stays runtime-portable for a future Cloudflare Worker.
 *
 *   tsx src/cli.ts [snapshot.json] list
 *   tsx src/cli.ts [snapshot.json] <did|user|queue|attendant> <ref>
 *   tsx src/cli.ts [snapshot.json] gallery      (default — a curated legibility test page)
 *
 * If no snapshot path is given, the newest *-snapshot.json under ./fixtures is used.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  resolveFlow,
  listEntities,
  toMermaid,
  renderGalleryHtml,
  type EntityRef,
  type FlowGraph,
  type Snapshot,
} from '@dszp/netsapiens-lib';

function newestSnapshot(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('-snapshot.json') && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return best ? best.path : null;
}

function loadSnapshot(p: string): Snapshot {
  return JSON.parse(readFileSync(p, 'utf8')) as Snapshot;
}

const args = process.argv.slice(2);
let snapPath = args.find((a) => a.endsWith('.json'));
const rest = args.filter((a) => a !== snapPath);
if (!snapPath) snapPath = newestSnapshot(resolve('fixtures')) ?? undefined;
if (!snapPath) {
  console.error('No snapshot found. Pass a *-snapshot.json path or put one under ./fixtures.');
  process.exit(1);
}
const snap = loadSnapshot(snapPath);
attachAttendantDetails(snap, snapPath);
const domain = String(snap.meta?.domain ?? snap.domain?.domain ?? 'domain');

/**
 * Load per-AA menu detail (from GET .../autoattendants/{prompt}) if an `attendants/`
 * folder sits next to the snapshot. Each *.json is keyed by its `user` extension.
 * This is how the live viewer will feed menus the backup doesn't capture.
 */
function attachAttendantDetails(snap: Snapshot, snapPath: string) {
  const dir = join(resolve(snapPath, '..'), 'attendants');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const details: Record<string, any> = {};
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const ext = String(d.user ?? f.replace(/\.json$/, ''));
      details[ext] = d;
    } catch {
      /* skip unreadable */
    }
  }
  if (Object.keys(details).length) snap.attendantDetails = details;
}
const mode = rest[0] ?? 'gallery';

const outDir = resolve('out');
mkdirSync(outDir, { recursive: true });

if (mode === 'list') {
  const e = listEntities(snap);
  console.log(`# ${domain}\n`);
  for (const [k, arr] of Object.entries(e)) {
    console.log(`${k}:`);
    for (const it of arr as any[]) console.log(`  ${it.ref}  ${it.label}${it.desc ? `  — ${it.desc}` : ''}`);
    console.log('');
  }
  process.exit(0);
}

/** Curate an interesting entity set for the gallery legibility test. */
function curate(): EntityRef[] {
  const e = listEntities(snap);
  const picks: EntityRef[] = [];
  const ruleCount = (ext: string) => (snap.answerrulesByUser?.[ext] ?? []).length;
  const rank = (p: any) => {
    const app = String(p['dial-rule-application'] ?? '');
    const dest = String(p['dial-rule-translation-destination-user'] ?? '');
    if (/to-callqueue/.test(app)) return 3; // straight into a queue
    if (/to-user/.test(app) && ruleCount(dest) > 1) return 3; // TOD / time-of-day router
    if (/to-user/.test(app)) return 1; // direct to a person
    return 0; // to-connection / fax / other
  };
  // The most interesting DID (main line) first, then one plain person DID for contrast.
  const dids = [...(snap.phonenumbers ?? [])].sort((a, c) => rank(c) - rank(a));
  const main = dids.find((p) => rank(p) >= 3);
  if (main) picks.push({ kind: 'did', ref: String(main.phonenumber) });
  const direct = dids.find((p) => rank(p) === 1);
  if (direct) picks.push({ kind: 'did', ref: String(direct.phonenumber) });
  for (const q of e.queues) picks.push({ kind: 'queue', ref: q.ref });
  for (const a of e.attendants) picks.push({ kind: 'attendant', ref: a.ref });
  if (e.users[0]) picks.push({ kind: 'user', ref: e.users[0].ref });
  return picks;
}

const entities: EntityRef[] = mode === 'gallery' ? curate() : [{ kind: mode as EntityRef['kind'], ref: rest[1] ?? '' }];

const graphs: FlowGraph[] = entities.map((ent) => resolveFlow(snap, ent));

// write .mmd files + a combined gallery HTML
for (const g of graphs) {
  const mmd = toMermaid(g);
  writeFileSync(join(outDir, `${g.domain}.${g.entity.kind}.${g.entity.ref}.mmd`), mmd);
}
const htmlPath = join(outDir, `${domain}.gallery.html`);
writeFileSync(htmlPath, renderGalleryHtml(domain, graphs, { subtitle: `Phase-1 spike · resolved from snapshot · ${graphs.length} flows` }));
console.log(`Wrote ${graphs.length} flow(s) for ${domain}`);
console.log(`Gallery: ${htmlPath}`);
for (const g of graphs) console.log(`  - ${g.entity.kind} ${g.entity.ref}: ${g.entity.label}  (${g.nodes.length} nodes, ${g.edges.length} edges, ${g.notes.length} notes)`);
