'use strict';
/*
 * extract-fn.js — Etape 0 safety-net helper.
 *
 * The client rules engine currently lives inside client/public/index.html as
 * browser-transpiled (Babel-standalone) JSX. The pure, side-effect-free helper
 * functions (parseSpellEffects, mana math, type checks, decklist parsing) cannot
 * be `require`d directly. Rather than copy-pasting them into tests (the old,
 * rot-prone pattern in test-game-logic.js), this helper extracts their REAL
 * source text from index.html and evaluates it in an isolated vm sandbox.
 *
 * Why this matters for the refactor: these tests pin the CURRENT behavior of the
 * actual source. When Etape 1 moves these functions into a real module, point
 * SOURCE_FILE / loadFns at the new file — the same characterization tests must
 * stay green. That is the safety net.
 *
 * The scanner is a tiny JS lexer that tracks strings / template literals /
 * regexes / comments so that braces, parens and semicolons inside them do not
 * confuse the "find the end of this declaration" logic.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '..', '..', 'client', 'public', 'index.html');

// Characters after which a `/` begins a regex literal (expression position)
// rather than a division operator. Sufficient for this codebase.
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^',
]);

/**
 * Given full source and the index of the `c` in `const`, scan forward and
 * return the index just past the top-level `;` that terminates the declaration.
 */
function findDeclarationEnd(src, start) {
  let i = start;
  let depth = 0; // combined () [] {} depth
  let lastSignificant = '\n'; // last non-space, non-comment char seen
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // Comments
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      lastSignificant = quote;
      continue;
    }

    // Template literals (no nested ${} expression support needed here, but handle escapes)
    if (c === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        i++;
      }
      lastSignificant = '`';
      continue;
    }

    // Regex literal
    if (c === '/' && REGEX_PRECEDERS.has(lastSignificant)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      // skip regex flags
      while (i < n && /[a-z]/i.test(src[i])) i++;
      lastSignificant = '/';
      continue;
    }

    // Depth tracking
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;

    if (c === ';' && depth === 0) {
      return i + 1;
    }

    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  throw new Error('Unterminated declaration starting at index ' + start);
}

/** Extract the source text of a top-level `const NAME = ...;` declaration. */
function extractConst(src, name) {
  const re = new RegExp('(^|\\n)\\s*const ' + name + '\\s*=', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('Could not find declaration: const ' + name);
  const start = m.index + m[0].indexOf('const');
  const end = findDeclarationEnd(src, start);
  return src.slice(start, end);
}

/**
 * Extract the named functions from index.html and evaluate them together.
 * Returns an object mapping name -> callable.
 *
 * Evaluation uses `new Function` rather than the `vm` module on purpose: vm runs
 * code in a separate realm, so values it returns carry that realm's Object/Array
 * prototypes and fail deepStrictEqual against test-realm literals. `new Function`
 * runs in the current realm (correct prototypes) while the extracted `const`
 * declarations stay scoped inside the function body, so nothing leaks to globals.
 *
 * Functions are concatenated in the given order so earlier ones are visible to
 * later ones (none of the current targets depend on each other, but this keeps
 * the door open).
 */
function loadFns(names, sourceFile = SOURCE_FILE) {
  const src = fs.readFileSync(sourceFile, 'utf8');
  const pieces = names.map((n) => extractConst(src, n));
  const body = pieces.join('\n\n') + '\nreturn {' + names.join(', ') + '};\n';
  try {
    const factory = new Function(body);
    return factory();
  } catch (err) {
    throw new Error('Failed to evaluate extracted functions [' + names.join(', ') + ']: ' + err.message);
  }
}

module.exports = { SOURCE_FILE, extractConst, findDeclarationEnd, loadFns };
