/**
 * Emitted-template hygiene. pnpm test:templates
 *
 * ⚠️ THIS FILE IMPORTS NOTHING FROM src/, AND THAT IS THE ENTIRE REASON IT EXISTS.
 *
 * The defect it hunts — a backtick inside a comment inside an emitted client-JS template — is a PARSE
 * error. Put this check in any suite that imports the module it is checking and it can never run: the
 * import fails first, the runner dies on a TransformError, and the one test that would have named the
 * line never executes. It lived in statusPage.selftest.ts for about ten minutes before that was
 * demonstrated by breaking the source and watching the suite crash in silence.
 *
 * So it reads the files as TEXT. Which also means it keeps working on a tree that does not compile,
 * which is exactly the tree you are on when you need it.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '\u2713' : '\u2717 FAIL'} ${m}`); };

// ── OPEN ITEM 51: A BACKTICK IN A COMMENT INSIDE AN EMITTED TEMPLATE ─────────────────────────────────
//
// kit.ts and statusPage.ts emit client JavaScript inside template literals. A backtick anywhere in one —
// INCLUDING inside a comment nobody would think of as code — ends the literal, and TypeScript then
// reports the error dozens of lines later at whatever it hit next, never at the cause. Five occurrences
// in the session that built the menu editor, three more in the one that reviewed it; every single time
// on a comment that had just been written, and every time a minute spent at a line number that was not
// where the problem was.
//
// The compiler does catch it, so nothing ships broken. What it does not do is SAY WHAT HAPPENED. This
// does: the line, and the reason. It scans SOURCE, because by the time it is output the damage has
// become a syntax error somewhere else entirely.
//
// Bodies are located by their own delimiters rather than by tracking nesting line by line — the first
// version of this guard mis-tracked depth and flagged eleven comments that were nowhere near a template,
// which is the failure mode that gets a guard deleted rather than fixed.
{
  const BT = String.fromCharCode(96);
  const bodies: { file: string; from: number; text: string }[] = [];
  const src: Record<string, string> = {};
  for (const file of ['kit.ts', 'statusPage.ts']) {
    src[file] = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    // ⚠️ ANCHORED ON THE DECLARATION, not on the words. The first cut searched for the bare
    // "String.raw" + backtick and matched it inside a DOC COMMENT that mentions it — opening a phantom
    // body that swallowed everything down to the next real close and reported eleven innocent comments.
    // The guard being bitten by exactly the class of thing it hunts is funny once; a guard that cries
    // wolf is deleted, which is the part that is not.
    const open = new RegExp(`^const \\w+ = String\\.raw${BT}`, 'gm');
    for (const m of src[file]!.matchAll(open)) {
      const i = m.index!;
      // A body closes on the first backtick-semicolon after it, wherever on the line it sits — two of
      // these end mid-line (…disconnect()},8000);BT;) rather than on a line of their own, and assuming
      // otherwise ran one body over the next declaration and past four innocent doc comments.
      const end = src[file]!.indexOf(`${BT};`, i + m[0]!.length);
      if (end < 0) throw new Error(`unterminated String.raw template in ${file} — the guard is broken, not the code`);
      bodies.push({ file, from: i, text: src[file]!.slice(i, end) });
    }
    // The plain (non-String.raw) emitted templates: statusPage's console script and kit's primary. Both
    // close on a line that is nothing but a backtick and a semicolon, same as the String.raw ones — that
    // is the delimiter to look for, not a guess at the last statement inside them.
    const j = src[file]!.indexOf(`return ${BT}(function(){`);
    if (j >= 0) {
      // Two closings in practice: a line that is only a backtick-semicolon (kit's primary), and one that
      // finishes the IIFE on the same line (statusPage's console script). Take whichever comes first.
      const end = src[file]!.indexOf(`${BT};`, j + 10);
      if (end < 0) throw new Error(`unterminated script template in ${file} — the guard is broken, not the code`);
      bodies.push({ file, from: j, text: src[file]!.slice(j, end) });
    }
  }
  // ⚠️ AND THE STYLESHEET, which is a template literal too and was NOT covered. A backtick in a CSS
  // comment ends the literal exactly the way one in a JS comment does, and this guard watched only the
  // script bodies — so the case that actually bit (three times in one session, twice in `/* … */`) was
  // the one case it could not see. Prose about code lives in comments, and comments live in both.
  {
    const j = src['statusPage.ts']!.indexOf(`const STYLE = ${BT}`);
    if (j < 0) throw new Error('could not find the emitted stylesheet — the guard is broken, not the code');
    const end = src['statusPage.ts']!.indexOf(`${BT};`, j + 10);
    if (end < 0) throw new Error('unterminated stylesheet template — the guard is broken, not the code');
    bodies.push({ file: 'statusPage.ts', from: j, text: src['statusPage.ts']!.slice(j, end) });
  }
  if (bodies.length < 6) throw new Error(`found only ${bodies.length} emitted bodies — the guard is broken, not the code`);

  const offenders: string[] = [];
  for (const b of bodies) {
    const startLine = src[b.file]!.slice(0, b.from).split('\n').length;
    b.text.split('\n').forEach((line, i) => {
      const t = line.trim();
      // ⚠️ EVERY LINE, not just whole-line comments. The first version of this guard tested
      // `t.startsWith('//')`, on the reasoning that real code needs its backticks and gets them right —
      // and then missed three in one session: one in a TRAILING comment after code, and two inside a CSS
      // /* … */ block, which starts with neither marker on its continuation lines. The rule these bodies
      // actually live under is simpler and worth enforcing as written: a plain template literal cannot
      // contain a backtick at all, anywhere, in code or prose. If emitted code ever genuinely needs one
      // it has to be an escape, and an escape does not match this.
      // Line 0 is the body's own opening delimiter — it IS the backtick that starts the literal.
      if (i > 0 && t.includes(BT)) offenders.push(`${b.file}:${startLine + i}  ${t.slice(0, 70)}`);
    });
  }
  ok(offenders.length === 0,
    `no backtick ANYWHERE inside an emitted template — it ends the literal, and the compiler then blames a line far below it${offenders.length ? `\n      ${offenders.join('\n      ')}` : ''}`);

  // ── AND THE SIBLING TRAP: A LONE BACKSLASH IN A PLAIN TEMPLATE ────────────────────────────────────
  //
  // statusPage's script is emitted from a NORMAL template literal, so a backslash is an escape and never
  // reaches the browser. Every regex in it needs doubling. It did not have it, and nothing noticed:
  //
  //   /^log\s*out\b/i   became   /^logs*out<backspace>/i
  //
  // — the preview's Log Out finder, matching nothing any portal renders, so added entries drew at the
  // END of the account menu instead of above the divider before it. kit.ts has the identical regex and
  // is correct, because that file uses String.raw. The live menu was right; only the picture was wrong,
  // which is the most durable kind of wrong: nobody checks a preview against the thing it previews.
  //
  // Flagged: any lone backslash that is not one of the escapes this codebase means on purpose (\\ to
  // emit one, \u for a character, \n, and the two that keep a template literal closed). Comments are
  // included deliberately — a comment that writes \host\ teaches the next reader that a lone backslash
  // is fine here, and it is not.
  const escapes: string[] = [];
  for (const b of bodies) {
    if (b.text.startsWith('const')) continue;          // String.raw bodies: a backslash is literal there
    const startLine = src[b.file]!.slice(0, b.from).split('\n').length;
    b.text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\\(.)/g)) {
        if ('\\un`$\''.includes(m[1]!)) continue;
        escapes.push(`${b.file}:${startLine + i}  \\${m[1]}  ${line.trim().slice(0, 66)}`);
      }
    });
  }
  ok(escapes.length === 0,
    `no lone backslash in a plain emitted template — it is an escape, so it never reaches the browser and a regex silently loses its class${escapes.length ? `\n      ${[...new Set(escapes)].join('\n      ')}` : ''}`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
