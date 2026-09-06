/** Offline test for the cached catalogue index. pnpm test:onebillcatalog */
import { loadCatalogIndex, CATALOG_TTL_S, type CatalogSource } from './onebillCatalog.js';
import { REFRESH_COOLDOWN_S, type OnebillEnv } from './onebill.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const env: OnebillEnv = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p', CACHE_SCOPE: 'test' };

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    cache: {
      match: async (r: Request) => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
      put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
      delete: async (r: Request) => store.delete(r.url),
    } as unknown as Cache,
  };
}

function fakeSource() {
  let listCalls = 0;
  const getCalls: string[] = [];
  const source: CatalogSource = {
    listProducts: async () => {
      listCalls++;
      return [{ code: 'A', name: 'A' }, { code: 'B', name: 'B' }, { code: '', name: 'nocode' }];
    },
    getProduct: async (code: string) => {
      getCalls.push(code);
      if (code === 'B') throw new Error('boom');
      return { code: 'A', name: 'A', pricePlanInfos: [{ code: 'A1', name: 'Plan A1' }] } as never;
    },
  };
  return { source, calls: () => ({ listCalls, getCalls: [...getCalls] }) };
}

// -- a fresh load reads listProducts once and getProduct per non-empty code -----------------------
{
  const { cache } = fakeCache();
  const { source, calls } = fakeSource();
  const index = await loadCatalogIndex(env, cache, { source });

  ok(!!index.byPlanName['plan a1'], 'the index has "plan a1"');
  ok(JSON.stringify(index.missingProducts) === JSON.stringify(['B']), 'the code whose detail read failed is recorded in missingProducts');
  ok(calls().listCalls === 1, 'listProducts was called once');
  ok(!calls().getCalls.includes(''), 'the summary with an empty code is never fetched');
  ok(calls().getCalls.sort().join(',') === 'A,B', 'getProduct was called for every non-empty code');
  ok(typeof index.loadedAt === 'string' && index.loadedAt.endsWith('Z'), 'loadedAt is an ISO instant');
  ok(CATALOG_TTL_S === 86400, 'the TTL is a day');
}

// -- a second call is served from cache; refresh forces a re-read ----------------------------------
{
  const { cache } = fakeCache();
  const { source, calls } = fakeSource();
  await loadCatalogIndex(env, cache, { source });
  const after1 = calls();

  await loadCatalogIndex(env, cache, { source });
  ok(calls().listCalls === after1.listCalls, 'a second load hits the cache — listProducts not called again');
  ok(calls().getCalls.length === after1.getCalls.length, 'and getProduct not called again either');

  await loadCatalogIndex(env, cache, { source, refresh: true });
  ok(calls().listCalls === after1.listCalls, 'a refresh inside REFRESH_COOLDOWN_S is served from the entry — this is the widest fan-out any one request can ask for, one getProduct per product code');

  const index2 = await loadCatalogIndex(env, cache, { source, refresh: true, now: new Date(Date.now() + (REFRESH_COOLDOWN_S + 1) * 1000) });
  ok(calls().listCalls === after1.listCalls + 1, 'and past the cooldown refresh: true re-reads listProducts');
  ok(!!index2.byPlanName['plan a1'], 'and the refreshed index is still correct');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
