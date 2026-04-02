#!/usr/bin/env node
// emoji_width_test.mjs — Unit tests and performance benchmarks for the
// grapheme-aware emoji width patch in hterm_all.patches.js.
//
// Run: node test/emoji_width_test.mjs
//
// Requires Node 16+ (Intl.Segmenter, Unicode property escapes).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Extract the original hterm width tables from the minified source ────

const htermSrc = readFileSync(
  join(__dirname, '..', 'blink', 'Resources', 'hterm_all.min.js'),
  'utf8'
);

function extractTable(name) {
  const marker = `B.wc.${name}`;
  const idx = htermSrc.indexOf(marker);
  if (idx < 0) throw new Error(`Table ${name} not found`);
  const start = htermSrc.indexOf('[', idx);
  let depth = 0;
  for (let i = start; i < start + 15000; i++) {
    if (htermSrc[i] === '[') depth++;
    else if (htermSrc[i] === ']') { depth--; if (depth === 0) return JSON.parse(htermSrc.slice(start, i + 1)); }
  }
  throw new Error(`Could not parse table ${name}`);
}

const combining = extractTable('combining');
const unambiguous = extractTable('unambiguous');

function binarySearch(cp, table) {
  // table is [[low,high], [low,high], ...] (nested pairs)
  let lo = 0, hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < table[mid][0]) hi = mid - 1;
    else if (cp > table[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// Original hterm charWidth (reconstructed from minified source)
function origCharWidth(cp) {
  if (cp < 127) return cp >= 32 ? 1 : 0;
  if (cp < 160) return 0;
  if (binarySearch(cp, combining)) return 0;
  if (binarySearch(cp, unambiguous)) return 2;
  return 1;
}

function origStrWidth(str) {
  let w = 0;
  for (let i = 0; i < str.length;) {
    const cp = str.codePointAt(i);
    const cw = origCharWidth(cp);
    if (cw < 0) return -1;
    w += cw;
    i += cp <= 0xFFFF ? 1 : 2;
  }
  return w;
}

// ── Patched implementation (mirrors hterm_all.patches.js) ───────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emojiPresentationRe = /\p{Emoji_Presentation}/u;
const emojiVS16Re = /\p{Emoji}\uFE0F/u;
const mayContainEmojiRe = /[\u00A9\u00AE\u200D\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\uFE0F\u{1F000}-\u{1FFFF}\u{E0020}-\u{E007F}]/u;
const pureAsciiRe = /^[\x20-\x7e]*$/;

function graphemeWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (grapheme.length === 1 && cp >= 0x20 && cp <= 0x7E) return 1;
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  if (emojiPresentationRe.test(grapheme) || emojiVS16Re.test(grapheme)) return 2;
  const w = origCharWidth(cp);
  return w < 0 ? 0 : w;
}

function patchedStrWidth(str) {
  if (!str) return 0;
  if (pureAsciiRe.test(str)) return str.length;
  if (!mayContainEmojiRe.test(str)) return origStrWidth(str);
  let width = 0;
  for (const seg of segmenter.segment(str)) {
    const w = graphemeWidth(seg.segment);
    if (w < 0) return -1;
    width += w;
  }
  return width;
}

function patchedSubstr(str, start, optWidth) {
  if (!str) return '';
  if (pureAsciiRe.test(str)) {
    return optWidth != null ? str.substring(start, start + optWidth) : str.substring(start);
  }
  const segments = Array.from(segmenter.segment(str));
  let col = 0, i = 0;
  while (i < segments.length) {
    const w = graphemeWidth(segments[i].segment);
    if (col + w > start) break;
    col += w; i++;
  }
  const startIdx = i < segments.length ? segments[i].index : str.length;
  if (optWidth == null) return str.substring(startIdx);
  let widthSoFar = 0, endI = i;
  while (endI < segments.length) {
    const w = graphemeWidth(segments[endI].segment);
    if (widthSoFar + w > optWidth) break;
    widthSoFar += w; endI++;
  }
  const endIdx = endI < segments.length ? segments[endI].index : str.length;
  return str.substring(startIdx, endIdx);
}

function patchedSplitWide(str) {
  if (!str) return [];
  if (pureAsciiRe.test(str)) {
    return [{ str, wcNode: false, asciiNode: true, wcStrWidth: str.length }];
  }
  const hasEmoji = mayContainEmojiRe.test(str);
  const rv = [];
  let narrowStart = 0, narrowEnd = 0, narrowWidth = 0, isAscii = true;
  if (hasEmoji) {
    const segments = Array.from(segmenter.segment(str));
    for (const seg of segments) {
      const g = seg.segment;
      const w = graphemeWidth(g);
      if (w === 2) {
        if (narrowEnd > narrowStart)
          rv.push({ str: str.substring(narrowStart, narrowEnd), wcNode: false, asciiNode: isAscii, wcStrWidth: narrowWidth });
        rv.push({ str: g, wcNode: true, asciiNode: false, wcStrWidth: 2 });
        narrowStart = seg.index + g.length; narrowEnd = narrowStart; narrowWidth = 0; isAscii = true;
      } else {
        narrowEnd = seg.index + g.length; narrowWidth += w;
        if (g.length > 1 || g.charCodeAt(0) > 127) isAscii = false;
      }
    }
  } else {
    for (let i = 0; i < str.length;) {
      const cp = str.codePointAt(i);
      const cpLen = cp <= 0xFFFF ? 1 : 2;
      let w = origCharWidth(cp); if (w < 0) w = 0;
      if (w === 2) {
        if (narrowEnd > narrowStart)
          rv.push({ str: str.substring(narrowStart, narrowEnd), wcNode: false, asciiNode: isAscii, wcStrWidth: narrowWidth });
        rv.push({ str: str.substring(i, i + cpLen), wcNode: true, asciiNode: false, wcStrWidth: 2 });
        narrowStart = i + cpLen; narrowEnd = narrowStart; narrowWidth = 0; isAscii = true;
      } else {
        narrowEnd = i + cpLen; narrowWidth += w;
        if (cp > 127) isAscii = false;
      }
      i += cpLen;
    }
  }
  if (narrowEnd > narrowStart)
    rv.push({ str: str.substring(narrowStart, narrowEnd), wcNode: false, asciiNode: isAscii, wcStrWidth: narrowWidth });
  if (rv.length === 0 && str.length > 0)
    rv.push({ str, wcNode: false, asciiNode: false, wcStrWidth: 0 });
  return rv;
}

// ── Test runner ─────────────────────────────────────────────────────────

let passed = 0, failed = 0, errors = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; errors.push(msg); }
}

function eq(actual, expected, label) {
  const ok = actual === expected;
  assert(ok, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  return ok;
}

// ── 1. Width correctness tests ──────────────────────────────────────────

console.log('=== Width Correctness ===\n');

const widthTests = [
  // [input, origWidth, patchedWidth, description]
  ['hello',                                          5, 5,  'pure ASCII'],
  ['',                                               0, 0,  'empty string'],
  [' ',                                              1, 1,  'single space'],

  // Single-codepoint emoji (in unambiguous table)
  ['\u{1F9E0}',                                      2, 2,  'brain (in table)'],
  ['\u{1F4B8}',                                      2, 2,  'flying money (in table)'],
  ['\u{1F4AD}',                                      2, 2,  'thought bubble (in table)'],
  ['\u{1F525}',                                      2, 2,  'fire (in table)'],
  ['\u{1F680}',                                      2, 2,  'rocket (in table)'],

  // VS-16 emoji (base NOT in unambiguous table — the bug)
  ['\u{23F8}\uFE0F',                                 1, 2,  'pause + VS-16 (FIXED)'],
  ['\u{1F5C4}\uFE0F',                                1, 2,  'cabinet + VS-16 (FIXED)'],
  ['\u{2699}\uFE0F',                                 1, 2,  'gear + VS-16 (FIXED)'],
  ['\u{270F}\uFE0F',                                 1, 2,  'pencil + VS-16 (FIXED)'],
  ['\u{2328}\uFE0F',                                 1, 2,  'keyboard + VS-16 (FIXED)'],
  ['\u{23F1}\uFE0F',                                 1, 2,  'stopwatch + VS-16 (FIXED)'],

  // ZWJ sequences (multiple codepoints → single 2-cell glyph)
  // orig: each emoji=2, ZWJ(U+200D)=0 (combining), so sums of visible codepoints
  ['\u{1F468}\u200D\u{1F4BB}',                       4, 2,  'man technologist ZWJ (FIXED)'],
  ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',        6, 2,  'family ZWJ (FIXED)'],
  ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', 8, 2, 'family of 4 ZWJ (FIXED)'],
  ['\u{1F3F3}\uFE0F\u200D\u{1F308}',                 3, 2,  'rainbow flag ZWJ (FIXED)'],

  // Skin tone modified
  ['\u{1F44B}\u{1F3FB}',                             4, 2,  'wave light skin (FIXED)'],
  ['\u{1F44B}\u{1F3FD}',                             4, 2,  'wave medium skin (FIXED)'],
  ['\u{1F44B}\u{1F3FF}',                             4, 2,  'wave dark skin (FIXED)'],
  ['\u{1F64F}\u{1F3FC}',                             4, 2,  'pray medium-light (FIXED)'],

  // Flag sequences (two regional indicators — NOT in unambiguous table, each=1 in orig)
  ['\u{1F1FA}\u{1F1F8}',                             2, 2,  'US flag (FIXED)'],
  ['\u{1F1EC}\u{1F1E7}',                             2, 2,  'GB flag (FIXED)'],
  ['\u{1F1EF}\u{1F1F5}',                             2, 2,  'JP flag (FIXED)'],

  // CJK (should remain width 2)
  ['\u{4E2D}',                                       2, 2,  'CJK: zhong'],
  ['\u{65E5}\u{672C}',                               4, 4,  'CJK: nihon (2 chars)'],

  // Combining marks (should remain width 0 added)
  ['e\u0301',                                        1, 1,  'e + combining acute'],
  ['n\u0303',                                        1, 1,  'n + combining tilde'],

  // Mixed strings
  ['abc\u{1F525}def',                                8, 8,  'mixed ASCII + emoji (in table)'],
  ['hi \u{23F8}\uFE0F there',                       10, 11, 'mixed with VS-16 pause (FIXED)'],
  ['\u{1F9E0} thinking \u{1F4AD}',                  14, 14, 'emoji + text + emoji'],
  ['status: \u{23F8}\uFE0F \u{1F5C4}\uFE0F end',   15, 17, 'statusbar with 2 broken emoji (FIXED)'],
];

for (const [input, origExpected, patchedExpected, desc] of widthTests) {
  const origActual = origStrWidth(input);
  const patchedActual = patchedStrWidth(input);
  eq(origActual, origExpected, `orig   ${desc}`);
  eq(patchedActual, patchedExpected, `patched ${desc}`);
}

// ── 2. substr correctness tests ────────────────────────────────────────

console.log('\n=== substr Correctness ===\n');

eq(patchedSubstr('hello', 0, 3), 'hel', 'ASCII substr(0,3)');
eq(patchedSubstr('hello', 2, 2), 'll', 'ASCII substr(2,2)');
eq(patchedSubstr('hello', 3, null), 'lo', 'ASCII substr(3,null)');

// Emoji at position: "ab🧠cd" — 🧠 is at col 2-3, c at col 4, d at col 5
eq(patchedSubstr('ab\u{1F9E0}cd', 0, 2), 'ab', 'substr before emoji');
eq(patchedSubstr('ab\u{1F9E0}cd', 0, 4), 'ab\u{1F9E0}', 'substr through emoji');
eq(patchedSubstr('ab\u{1F9E0}cd', 4, 2), 'cd', 'substr after emoji');
eq(patchedSubstr('ab\u{1F9E0}cd', 2, 2), '\u{1F9E0}', 'substr exactly emoji');

// ZWJ emoji: "a👨‍💻b" — ZWJ seq at col 1-2, b at col 3
eq(patchedSubstr('a\u{1F468}\u200D\u{1F4BB}b', 0, 1), 'a', 'substr before ZWJ');
eq(patchedSubstr('a\u{1F468}\u200D\u{1F4BB}b', 1, 2), '\u{1F468}\u200D\u{1F4BB}', 'substr exactly ZWJ');
eq(patchedSubstr('a\u{1F468}\u200D\u{1F4BB}b', 3, null), 'b', 'substr after ZWJ');

// ── 3. splitWidecharString correctness ──────────────────────────────────

console.log('\n=== splitWidecharString Correctness ===\n');

let segs;

segs = patchedSplitWide('hello');
eq(segs.length, 1, 'ASCII: 1 segment');
eq(segs[0].asciiNode, true, 'ASCII: asciiNode');
eq(segs[0].wcStrWidth, 5, 'ASCII: width 5');

segs = patchedSplitWide('ab\u{1F9E0}cd');
eq(segs.length, 3, 'mixed: 3 segments');
eq(segs[0].str, 'ab', 'mixed: first narrow');
eq(segs[1].str, '\u{1F9E0}', 'mixed: emoji node');
eq(segs[1].wcNode, true, 'mixed: wcNode true');
eq(segs[1].wcStrWidth, 2, 'mixed: emoji width 2');
eq(segs[2].str, 'cd', 'mixed: last narrow');

// ZWJ emoji should be a single wcNode
segs = patchedSplitWide('x\u{1F468}\u200D\u{1F4BB}y');
eq(segs.length, 3, 'ZWJ: 3 segments');
eq(segs[1].wcNode, true, 'ZWJ: wcNode true');
eq(segs[1].wcStrWidth, 2, 'ZWJ: width 2');
eq(segs[1].str, '\u{1F468}\u200D\u{1F4BB}', 'ZWJ: full sequence in one node');

// VS-16 emoji should be a single wcNode
segs = patchedSplitWide('a\u{23F8}\uFE0Fb');
eq(segs.length, 3, 'VS-16: 3 segments');
eq(segs[1].wcNode, true, 'VS-16: wcNode true');
eq(segs[1].wcStrWidth, 2, 'VS-16: width 2');

// Flag emoji
segs = patchedSplitWide('\u{1F1FA}\u{1F1F8}');
eq(segs.length, 1, 'flag: 1 segment');
eq(segs[0].wcNode, true, 'flag: wcNode true');
eq(segs[0].wcStrWidth, 2, 'flag: width 2');

// ── 4. Fast-path verification ───────────────────────────────────────────

console.log('\n=== Fast-Path Verification ===\n');

eq(pureAsciiRe.test('hello world 123!@#'), true, 'pureAscii detects ASCII');
eq(pureAsciiRe.test('hello\t'), false, 'pureAscii rejects tab');
eq(pureAsciiRe.test('caf\u00E9'), false, 'pureAscii rejects latin-1');
eq(mayContainEmojiRe.test('hello'), false, 'mayContainEmoji: no for ASCII');
eq(mayContainEmojiRe.test('\u{4E2D}\u{6587}'), false, 'mayContainEmoji: no for CJK');
eq(mayContainEmojiRe.test('caf\u00E9'), false, 'mayContainEmoji: no for latin-1');
eq(mayContainEmojiRe.test('\u{1F525}'), true, 'mayContainEmoji: yes for emoji');
eq(mayContainEmojiRe.test('\u{23F8}\uFE0F'), true, 'mayContainEmoji: yes for VS-16');

// ── 5. Performance benchmarks ───────────────────────────────────────────

console.log('\n=== Performance Benchmarks ===\n');

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const ASCII_CHARS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const SINGLE_EMOJI = ['\u{1F9E0}','\u{1F4B8}','\u{1F4AD}','\u{1F525}','\u{1F680}'];
const VS16_EMOJI = ['\u{23F8}\uFE0F','\u{1F5C4}\uFE0F','\u{2699}\uFE0F','\u{23F1}\uFE0F'];
const ZWJ_EMOJI = ['\u{1F468}\u200D\u{1F4BB}','\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'];
const SKIN_EMOJI = ['\u{1F44B}\u{1F3FB}','\u{1F44B}\u{1F3FF}'];
const FLAG_EMOJI = ['\u{1F1FA}\u{1F1F8}','\u{1F1EF}\u{1F1F5}'];

function randomLine(rng, cols) {
  let s = '';
  for (let i = 0; i < cols; i++) s += ASCII_CHARS[Math.floor(rng() * ASCII_CHARS.length)];
  return s;
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function generateScenario(name, lineCount, cols) {
  const rng = mulberry32(42);
  const allEmoji = [...SINGLE_EMOJI, ...VS16_EMOJI, ...ZWJ_EMOJI, ...SKIN_EMOJI, ...FLAG_EMOJI];
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    if (name === 'ascii') {
      lines.push(randomLine(rng, cols));
    } else if (name === 'light') {
      lines.push(rng() < 0.05
        ? randomLine(rng, cols - 4) + pick(rng, SINGLE_EMOJI) + ' '
        : randomLine(rng, cols));
    } else if (name === 'heavy') {
      if (rng() < 0.3) {
        let s = '';
        for (let e = 0; e < 4; e++) s += pick(rng, allEmoji) + randomLine(rng, 10);
        lines.push(s);
      } else {
        lines.push(randomLine(rng, cols));
      }
    } else if (name === 'multi') {
      let s = '';
      for (let e = 0; e < 3; e++) s += pick(rng, [...VS16_EMOJI, ...ZWJ_EMOJI, ...SKIN_EMOJI, ...FLAG_EMOJI]) + randomLine(rng, 15);
      lines.push(s);
    }
  }
  return lines;
}

function benchmark(fn, lines, label) {
  // Warmup
  for (let i = 0; i < Math.min(50, lines.length); i++) fn(lines[i]);

  const start = performance.now();
  let totalWidth = 0;
  for (let i = 0; i < lines.length; i++) totalWidth += fn(lines[i]);
  const elapsed = performance.now() - start;
  return { label, elapsed, lines: lines.length, totalWidth };
}

const BENCH_LINES = 5000;
const COLS = 80;
const scenarios = ['ascii', 'light', 'heavy', 'multi'];

console.log(`${'Scenario'.padEnd(10)} ${'Impl'.padEnd(10)} ${'Lines'.padStart(6)} ${'Time ms'.padStart(10)} ${'us/line'.padStart(10)} ${'TotalW'.padStart(10)}`);
console.log('-'.repeat(62));

for (const scenario of scenarios) {
  const lines = generateScenario(scenario, BENCH_LINES, COLS);
  const orig = benchmark(origStrWidth, lines, 'original');
  const patched = benchmark(patchedStrWidth, lines, 'patched');
  const ratio = patched.elapsed / orig.elapsed;
  const ratioStr = ratio > 1.05 ? `(${ratio.toFixed(1)}x slower)` : ratio < 0.95 ? `(${ratio.toFixed(1)}x faster)` : '(~same)';

  console.log(`${scenario.padEnd(10)} ${'original'.padEnd(10)} ${orig.lines.toString().padStart(6)} ${orig.elapsed.toFixed(2).padStart(10)} ${((orig.elapsed / orig.lines) * 1000).toFixed(2).padStart(10)} ${orig.totalWidth.toString().padStart(10)}`);
  console.log(`${' '.padEnd(10)} ${'patched'.padEnd(10)} ${patched.lines.toString().padStart(6)} ${patched.elapsed.toFixed(2).padStart(10)} ${((patched.elapsed / patched.lines) * 1000).toFixed(2).padStart(10)} ${patched.totalWidth.toString().padStart(10)}  ${ratioStr}`);
}

// ── Practical context ───────────────────────────────────────────────────

console.log('\nPractical impact (24-line terminal screen):');
for (const scenario of scenarios) {
  const lines = generateScenario(scenario, 24, COLS);
  const p = benchmark(patchedStrWidth, lines, 'patched');
  console.log(`  ${scenario.padEnd(8)} full-screen strWidth: ${(p.elapsed * 1000).toFixed(0)} us (${p.elapsed.toFixed(3)} ms)`);
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(62));
if (failed === 0) {
  console.log(`\nAll ${passed} tests passed.`);
} else {
  console.log(`\n${passed} passed, ${failed} FAILED:`);
  for (const e of errors) console.log(`  FAIL: ${e}`);
}
process.exit(failed > 0 ? 1 : 0);
