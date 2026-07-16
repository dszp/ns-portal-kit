/**
 * NetSapiens device enrichment — an OPTIONAL, gated integration (the desk-phone counterpart to the
 * Ringotel app enrichment in `ringotel.ts`). A BASIC first cut; the full unified-presence layer
 * (Ringotel app + NS device registration + ACD agent login) is scoped later.
 *
 * When enabled (`NS_DEVICE_DETAILS`), for each device/agent line that references a **provisioned
 * physical phone** (a device with a MAC), it annotates the line around the `(100)` token — a 🟢/🔴
 * presence circle BEFORE it (from `device-sip-registration-state`) and the phone model AFTER it
 * (from `device-models-brand-and-model`): "📞 Debbi Smith (100)" → "📞 Debbi Smith 🟢 (100) (Yealink
 * T54W)". Softphones (no MAC — incl. the Ringotel app `###r` registrations) are skipped; those are
 * handled by `ringotel.ts`.
 *
 * ONE domain call: `GET /domains/{domain}/phones` returns every MAC'd phone in the domain (model,
 * MAC, registration state), so we fetch once per domain rather than per-extension. The ext is parsed
 * from `device-provisioning-sip-uri-1` ("sip:100@domain" → "100").
 *
 * SECURITY — never cache secrets: this endpoint returns `device-provisioning-password` (and the
 * per-user variant returns SIP registration passwords). We extract ONLY the safe display fields into
 * `Phone` and cache/return THAT — the raw record (with any password) is never cached or logged.
 *
 * Gate + isolation match the integration convention: no `NS_DEVICE_DETAILS` ⇒ nothing runs, no extra
 * NS reads, NS-only baseline unchanged. Best-effort: a fetch failure is caught and never breaks /flow.
 * The one safe-projected phone list is Cache-API-cached per domain (TTL 5m).
 */

import { asArray, type NsClient, type FlowGraph, type Rec } from '@dszp/netsapiens-lib';

export interface NsDeviceEnv {
  /** Truthy ("1"/"true"/…) enables NS device-detail enrichment (model + registration presence). */
  NS_DEVICE_DETAILS?: string;
}

export function nsDeviceDetailsEnabled(env: NsDeviceEnv): boolean {
  const v = (env.NS_DEVICE_DETAILS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const DEVICE_TOKEN = /\((\d+[a-z]*)\)/g; // "(100)" / "(102r)" → the device aor
const enc = encodeURIComponent;

/** Safe, cache-able projection of a phone — NO secrets (no provisioning/registration password). */
export interface Phone {
  /** Extension the phone's primary line serves (from sip-uri-1). */
  aor: string;
  model: string;
  registered: boolean;
}

/** Trim the vendor "SIP-" noise: "Yealink SIP-T54W" → "Yealink T54W". */
function cleanModel(m: string): string {
  return m.replace(/\bSIP-/i, '').trim();
}

/** Extension from a SIP URI: "sip:100@domain" → "100". */
function extFromSipUri(uri: unknown): string {
  const m = String(uri ?? '').match(/^sips?:([^@;]+)@/i);
  return m ? m[1]! : '';
}

/**
 * Project a raw `/phones` record to the safe `Phone` shape — MAC-provisioned phones only. Returns
 * null for records without a MAC or a resolvable ext. Deliberately reads ONLY display fields so no
 * password ever leaves this function.
 */
export function phoneFromRecord(d: Rec): Phone | null {
  const mac = String(d['device-provisioning-mac-address'] ?? '').trim();
  if (!mac) return null; // physical phones only
  const aor = extFromSipUri(d['device-provisioning-sip-uri-1']);
  if (!aor) return null;
  const model = cleanModel(String(d['device-models-brand-and-model'] ?? d['device-models-model'] ?? ''));
  const registered = String(d['device-sip-registration-state'] ?? '').toLowerCase() === 'registered';
  return { aor, model, registered };
}

/**
 * Pure post-processor: annotate device/agent lines whose device aor maps to a phone in `byAor` —
 * 🟢/🔴 before the token, ` (model)` after. Mutates `graph`; returns the count annotated.
 */
export function annotateDevices(graph: FlowGraph, byAor: Map<string, Phone>): number {
  let changed = 0;
  for (const node of graph.nodes) {
    if (node.kind !== 'agents' && node.kind !== 'devices') continue;
    if (!Array.isArray(node.lines) || node.lines.length === 0) continue;
    node.lines = node.lines.map((line) =>
      line.replace(DEVICE_TOKEN, (full, aor) => {
        const phone = byAor.get(aor);
        if (!phone) return full; // only MAC'd phones are in the map
        changed++;
        const circle = `${phone.registered ? '🟢' : '🔴'} `;
        const model = phone.model ? ` (${phone.model})` : '';
        return `${circle}${full}${model}`;
      }),
    );
  }
  return changed;
}

// ── Cache API (safe projection only) ─────────────────────────────────────────
const domainPhonesKey = (domain: string) => `https://nsdevice-cache.internal/${domain}/phones`;
const PHONES_TTL = 300; // 5m — registration state drifts

async function cacheGet<T>(cache: Cache, key: string): Promise<T | undefined> {
  const hit = await cache.match(new Request(key));
  if (!hit) return undefined;
  try {
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}
async function cachePut(cache: Cache, key: string, value: unknown, ttl: number): Promise<void> {
  await cache.put(new Request(key), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } }));
}

/** All MAC'd phones in the domain, projected to the safe `Phone` shape and Cache-API-cached. */
async function getDomainPhones(client: NsClient, cache: Cache, domain: string, refresh: boolean): Promise<Phone[]> {
  const key = domainPhonesKey(domain);
  if (!refresh) {
    const hit = await cacheGet<Phone[]>(cache, key);
    if (hit) return hit;
  }
  // Project to safe fields BEFORE anything is cached — the raw records carry passwords.
  const phones = asArray(await client.get(`/domains/${enc(domain)}/phones`))
    .map(phoneFromRecord)
    .filter((p): p is Phone => p !== null);
  await cachePut(cache, key, phones, PHONES_TTL);
  return phones;
}

/**
 * Orchestrate NS device enrichment for one flow. NO-OP unless enabled (checked by the caller). ONE
 * domain call (cached) → index MAC'd phones by ext → annotate. Best-effort & isolated: a failure is
 * logged (message only, never a record) and never breaks /flow.
 */
export async function enrichDeviceDetails(graph: FlowGraph, client: NsClient, cache: Cache, domain: string, opts: { refresh?: boolean } = {}): Promise<void> {
  try {
    const phones = await getDomainPhones(client, cache, domain, opts.refresh ?? false);
    if (!phones.length) return;
    const byAor = new Map(phones.map((p) => [p.aor, p]));
    annotateDevices(graph, byAor);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'ns device enrichment failed', domain, error: (err as Error).message }));
  }
}
