/**
 * The OneBill catalogue as a plan-name index, cached — the piece `rulesUseCatalog` says a rulebook
 * with a `planCode`/`productCode` key needs. See onebill-lib's `catalog.ts` for why the index is keyed
 * by plan NAME: a subscription line names only its plan, never a code.
 */
import { buildCatalogIndex, type CatalogIndex, type Product, type ProductSummary } from '@dszp/onebill-lib';
import { domainHash, entryKey, makeReadClient, withinRefreshCooldown, type OnebillEnv } from './onebill.js';
import { scopeOf } from './ringotel.js';

export const CATALOG_TTL_S = 86400;

/** The two catalogue reads `loadCatalogIndex` needs. `OneBillReadClient` satisfies it. */
export interface CatalogSource {
  listProducts(): Promise<ProductSummary[]>;
  getProduct(code: string): Promise<Product>;
}

/** {@link CatalogIndex} plus the codes a product-detail read failed for, and when this copy was built. */
export type KitCatalogIndex = CatalogIndex & { loadedAt: string; missingProducts: string[] };

/**
 * Run `fn` over `items` with at most `limit` in flight. `onebill.ts` already has its own `pooled` for
 * the exact same purpose (not exported); this is that shape again rather than a second export from a
 * module this one already imports two names from — reuse would buy an import, not less code.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * The tenant's catalogue as a plan-name index, cached a day: it changes when someone edits a product
 * in OneBill, not per request. One `listProducts` call, then one `getProduct` per non-empty product
 * code at concurrency 4; a product whose detail read fails is skipped and its code recorded in
 * `missingProducts` rather than failing the whole load — a rule keyed on that one product's plans just
 * finds nothing, which is the same shape as a rule naming an offer nobody is subscribed to.
 */
export async function loadCatalogIndex(
  env: OnebillEnv,
  cache: Cache,
  opts: { refresh?: boolean; source?: CatalogSource; now?: Date } = {},
): Promise<KitCatalogIndex> {
  const key = entryKey(scopeOf(env), 'catalog', await domainHash(['catalog']));
  // Read on a refresh too: the same `?refresh=1` that reaches the two entries above reaches this one,
  // and it is the widest fan-out of the three — `listProducts` plus one `getProduct` per product code.
  // A refresh inside REFRESH_COOLDOWN_S of the entry it would replace is served from the entry.
  {
    const hit = await cache.match(key);
    const body = hit ? ((await hit.json().catch(() => null)) as Partial<KitCatalogIndex> | null) : null;
    if (body && body.byPlanName && Array.isArray(body.missingProducts)
      && (!opts.refresh || withinRefreshCooldown(body.loadedAt, opts.now ?? new Date()))) return body as KitCatalogIndex;
  }
  const source = opts.source ?? makeReadClient(env, cache);
  const summaries = (await source.listProducts()).filter((p) => typeof p.code === 'string' && p.code.trim() !== '');
  const missingProducts: string[] = [];
  const products = (await mapLimit(summaries, 4, async (p) => {
    try {
      return await source.getProduct(p.code!.trim());
    } catch {
      missingProducts.push(p.code!.trim());
      return null;
    }
  })).filter((p): p is Product => p !== null);
  const index: KitCatalogIndex = { ...buildCatalogIndex(products), loadedAt: (opts.now ?? new Date()).toISOString(), missingProducts };
  await cache.put(key, new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CATALOG_TTL_S}` } }));
  return index;
}
