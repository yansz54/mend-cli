// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (MIT).
// It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, matches lines at the
// first of three tiers, and writes every change or none. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}
function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: three-tier line matching ---------------------------------

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in F at the given tier, at or after `from`. */
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; or 0 only when strict) at which O occurs in F. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NItem {
  ctx: boolean;
  text: string;
}

/**
 * Build the replacement lines for a match at `pos`: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented (F replaces P), otherwise lines are as written.
 * `oCtx` holds, in order, the index within O of each of O's context lines.
 */
function buildReplacement(O: string[], oCtx: number[], N: NItem[], F: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let ci = 0;
  const p = O.length > 0 ? leadWs(O[0]!) : '';
  const f = O.length > 0 ? leadWs(F[pos]!) : '';
  for (const item of N) {
    if (item.ctx) {
      out.push(F[pos + oCtx[ci]!]!);
      ci += 1;
    } else if (tier === 2 && O.length > 0) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// ---- Section 9: JSON edits (as the starter had them) -----------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----------------------------------------------

interface BodyLine {
  type: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}
interface Hunk {
  A: number;
  body: BodyLine[];
}
interface UniSection {
  diffOld: string;
  diffNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  headerPair: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function parseDiffGit(line: string): { old: string; next: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/');
  if (idx < 0) return null;
  const old = rest.slice(2, idx);
  const next = rest.slice(idx + 3);
  if (old === '' || next === '') return null;
  return { old, next };
}
function parseHunkHeader(line: string): { A: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return { A: parseInt(m[1]!, 10) };
}
function bodyLineOf(raw: string): BodyLine {
  if (raw === '') return { type: 'ctx', text: '' };
  if (raw[0] === ' ') return { type: 'ctx', text: raw.slice(1) };
  if (raw[0] === '-') return { type: 'old', text: raw.slice(1) };
  if (raw[0] === '+') return { type: 'new', text: raw.slice(1) };
  return { type: 'bslash', text: raw.slice(1) };
}
const isBodyRaw = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
const isEmptyCtx = (b: BodyLine): boolean => b.type === 'ctx' && b.text === '';
/** Index of the last context or '+' body line, or -1 when there is none. */
function lastCtxOrPlus(body: BodyLine[]): number {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.type === 'ctx' || body[k]!.type === 'new') return k;
  }
  return -1;
}
/** True when a `\` line immediately follows the hunk's last context or '+' line. */
function hunkNoEol(body: BodyLine[]): boolean {
  const k = lastCtxOrPlus(body);
  return k >= 0 && body[k + 1] !== undefined && body[k + 1]!.type === 'bslash';
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const fresh = (old: string, next: string): UniSection => ({
    diffOld: old,
    diffNew: next,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    newFile: false,
    delFile: false,
    headerPair: false,
    hasHunk: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const d = parseDiffGit(line);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(d.old, d.next);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(headerPath(line));
      const newP = stripAB(headerPath(lines[i + 1]!));
      if (cur !== null && !cur.hasHunk && !cur.headerPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.headerPair = true;
      } else {
        cur = fresh(oldP, newP);
        cur.headerPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunkHeader(line);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.hasHunk = true;
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('@@') || bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyRaw(bl)) break;
        body.push(bodyLineOf(bl));
        j += 1;
      }
      while (body.length > 0 && isEmptyCtx(body[body.length - 1]!)) body.pop();
      cur.hunks.push({ A: h.A, body });
      i = j;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && !cur.hasHunk && !cur.headerPair) {
        cur.pairNew = stripAB(headerPath(line));
        cur.headerPair = true;
      }
      i += 1;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** The text of a created file: the `+` lines of all hunks, in order (section 6). */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let noEol = false;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      const b = h.body[k]!;
      if (b.type === 'new') {
        plus.push(b.text);
        noEol = h.body[k + 1] !== undefined && h.body[k + 1]!.type === 'bslash';
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noEol ? '' : '\n');
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const oItems: NItem[] = [];
    const nItems: NItem[] = [];
    for (const b of h.body) {
      if (b.type === 'ctx') {
        oItems.push({ ctx: true, text: b.text });
        nItems.push({ ctx: true, text: b.text });
      } else if (b.type === 'old') oItems.push({ ctx: false, text: b.text });
      else if (b.type === 'new') nItems.push({ ctx: false, text: b.text });
    }
    const O = oItems.map((x) => x.text);
    const oCtx: number[] = [];
    oItems.forEach((x, idx) => {
      if (x.ctx) oCtx.push(idx);
    });
    if (O.length > 0) {
      const found = findTier(O, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const repl = buildReplacement(O, oCtx, nItems, lines, pos, found.tier);
      const touchesEnd = pos + O.length === lines.length;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
      if (touchesEnd) ends = !hunkNoEol(h.body);
      d += repl.length - O.length;
    } else {
      const wasLen = lines.length;
      const ins = Math.max(0, Math.min(h.A + d, wasLen));
      const repl = nItems.map((x) => x.text);
      lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
      if (ins === wasLen) ends = !hunkNoEol(h.body);
      d += repl.length;
    }
  }
  return joinFile(lines, f.br, ends);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldPath = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
    const newPath = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
    if (oldPath === '/dev/null' || sec.newFile) {
      return (tree: Tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, creationText(sec.hunks));
      };
    }
    if (newPath === '/dev/null' || sec.delFile) {
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    if (oldPath !== newPath) {
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(before, sec.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      };
    }
    return (tree: Tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyHunks(before, sec.hunks, strict, oldPath));
    };
  });
}

// ---- Section 7: SEARCH/REPLACE blocks --------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    next: string[];
  }
  const blocks: Block[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let e = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        e = j;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, e), next: lines.slice(e + 1, r) });
    prevReplace = r;
    prevPath = path;
    i = r + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length > 0 ? b.next.join('\n') + '\n' : '');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(b.old, f.lines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const repl = buildReplacement(b.old, [], b.next.map((t) => ({ ctx: false, text: t })), f.lines, pos, found.tier);
    const out = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + b.old.length)];
    tree.now.set(b.path, joinFile(out, f.br, f.ends));
  });
}

// ---- Section 8: V4A patches -------------------------------------------------

interface VItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: VItem[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  updLine: number;
}

const ADD_P = '*** Add File: ';
const DEL_P = '*** Delete File: ';
const UPD_P = '*** Update File: ';
const MOV_P = '*** Move to: ';
const isVSectionStart = (l: string): boolean => l.startsWith(ADD_P) || l.startsWith(DEL_P) || l.startsWith(UPD_P);
const isBlankVItem = (x: VItem): boolean => x.kind === 'ctx' && x.text === '';

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD_P)) {
      const path = line.slice(ADD_P.length).trim();
      // Each collected line remembers whether its patch line was blank: only blank patch
      // lines at the end of the section are not part of it; a '+' line is a file line
      // even when its rest is empty.
      const collected: Array<{ text: string; blankLine: boolean }> = [];
      i += 1;
      while (i < last && !isVSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          collected.push({ text: l.slice(1), blankLine: false });
          i += 1;
        } else if (l === '') {
          collected.push({ text: '', blankLine: true });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1]!.blankLine) collected.pop();
      const addLines = collected.map((c) => c.text);
      sections.push({ kind: 'add', path, moveTo: null, addLines, chunks: [], updLine: 0 });
      continue;
    }
    if (line.startsWith(DEL_P)) {
      const path = line.slice(DEL_P.length).trim();
      sections.push({ kind: 'del', path, moveTo: null, addLines: [], chunks: [], updLine: 0 });
      i += 1;
      continue;
    }
    if (line.startsWith(UPD_P)) {
      const path = line.slice(UPD_P.length).trim();
      const updLine = i + 1;
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith(MOV_P)) {
        moveTo = lines[i]!.slice(MOV_P.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let afterEof = false;
      while (i < last) {
        const l = lines[i]!;
        if (isVSectionStart(l)) break;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          while (cur.items.length > 0 && isBlankVItem(cur.items[cur.items.length - 1]!)) cur.items.pop();
          chunks.push(cur);
          cur = null;
          afterEof = true;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
          afterEof = false;
          i += 1;
          continue;
        }
        if (blank(l)) {
          if (cur !== null && cur.items.length > 0) {
            cur.items.push({ kind: 'ctx', text: '' });
          }
          i += 1;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (afterEof) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, items: [] };
          }
          afterEof = false;
          cur.items.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.items.length > 0 && isBlankVItem(cur.items[cur.items.length - 1]!)) cur.items.pop();
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      sections.push({ kind: 'upd', path, moveTo, addLines: [], chunks, updLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length > 0 ? sec.addLines.join('\n') + '\n' : '');
      };
    }
    if (sec.kind === 'del') {
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const out = applyV4aChunks(before, sec.chunks, strict, sec.path);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, out);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, out);
      }
    };
  });
}

/** Apply an Update File section's chunks in order, with a cursor (section 8). */
function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let cursor = 0;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const ch of chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      let found = -1;
      outer: for (const t of tiers) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(ch.anchor, lines[k]!, t)) {
            found = k;
            break outer;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O: string[] = [];
    const N: NItem[] = [];
    const oCtx: number[] = [];
    for (const x of ch.items) {
      if (x.kind === 'ctx') {
        oCtx.push(O.length);
        O.push(x.text);
        N.push({ ctx: true, text: x.text });
      } else if (x.kind === 'old') {
        O.push(x.text);
      } else {
        N.push({ ctx: false, text: x.text });
      }
    }
    if (O.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const repl = N.map((x) => x.text);
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at)];
      cursor = at + repl.length;
      continue;
    }
    let hit: { tier: number; pos: number } | null = null;
    for (const t of tiers) {
      const cands = occurrences(O, lines, t, cursor);
      const ok = ch.eof ? cands.filter((p) => p + O.length === lines.length) : cands;
      if (ok.length > 0) {
        hit = { tier: t, pos: ok[0]! };
        break;
      }
    }
    if (hit === null) throw new Fail('no-match', path);
    const repl = buildReplacement(O, oCtx, N, lines, hit.pos, hit.tier);
    lines = [...lines.slice(0, hit.pos), ...repl, ...lines.slice(hit.pos + O.length)];
    cursor = hit.pos + repl.length;
  }
  return joinFile(lines, f.br, f.ends);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      const di = rows.findIndex((r) => r.key === oldP && r.text.startsWith('D '));
      const ai = rows.findIndex((r) => r.key === newP && r.text.startsWith('A '));
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
