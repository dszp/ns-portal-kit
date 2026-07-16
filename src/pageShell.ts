/**
 * The shared shell for operator-facing pages (first-run setup, the Access gate).
 *
 * Self-contained by requirement: no CDN, no fonts, no script. These pages exist precisely when the
 * deployment is broken or unconfigured, so they must render with nothing else working.
 */

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PageItem {
  level: 'blocker' | 'warning' | 'step';
  title: string;
  /** Plain prose. Escaped. */
  body: string[];
  /** Optional command/snippet, rendered monospace. Escaped. */
  code?: string;
}

const TAG: Record<PageItem['level'], string> = { blocker: 'must fix', warning: 'review', step: '' };

export function page(opts: { title: string; heading: string; intro: string; items: PageItem[]; footer: string }): string {
  const items = opts.items
    .map((i, n) => {
      const tag = TAG[i.level] ? `<span class="tag ${i.level}">${TAG[i.level]}</span>` : `<span class="num">${n + 1}</span>`;
      const body = i.body.map((p) => `<p>${esc(p)}</p>`).join('');
      const code = i.code ? `<pre>${esc(i.code)}</pre>` : '';
      return `<li class="${i.level}"><div class="t">${tag}${esc(i.title)}</div>${body}${code}</li>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1e293b; --dim:#64748b; --bg:#f8fafc; --card:#fff; --line:#e2e8f0;
          --red:#b91c1c; --amber:#b45309; --blue:#1a6bb0; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --dim:#94a3b8; --bg:#0f172a; --card:#1e293b;
          --line:#334155; --red:#f87171; --amber:#fbbf24; --blue:#5b8bc0; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:2.5rem 1.25rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:46rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .35rem; }
  .sub { color:var(--dim); margin:0 0 1.75rem; }
  ol,ul { list-style:none; padding:0; margin:0 0 1.75rem; counter-reset:s; }
  li { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:8px;
       padding:1rem 1.1rem; margin-bottom:.75rem; }
  li.blocker { border-left-color:var(--red); } li.warning { border-left-color:var(--amber); }
  li.step { border-left-color:var(--blue); }
  .t { font-weight:600; display:flex; gap:.6rem; align-items:baseline; }
  .tag { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; padding:.1rem .4rem;
         border-radius:4px; border:1px solid var(--line); color:var(--dim); font-weight:600; }
  .num { flex:0 0 1.35rem; height:1.35rem; border-radius:50%; background:var(--blue); color:#fff;
         font-size:.75rem; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
  p { margin:.45rem 0 0; color:var(--dim); }
  li p:last-of-type { color:var(--fg); }
  pre { margin:.6rem 0 0; padding:.6rem .7rem; background:var(--bg); border:1px solid var(--line);
        border-radius:6px; overflow-x:auto; font-size:.85em; color:var(--fg); }
  code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.9em; }
  footer { color:var(--dim); font-size:.85rem; border-top:1px solid var(--line); padding-top:1rem; }
</style></head><body><main>
<h1>${esc(opts.heading)}</h1>
<p class="sub">${esc(opts.intro)}</p>
<ol>
${items}
</ol>
<footer>${opts.footer}</footer>
</main></body></html>`;
}
