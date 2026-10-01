// Strips comments and whitespace from WGSL for the production build.
//
// Two sources of WGSL get minified:
//   - .wgsl files
//   - template literals tagged with a `/* wgsl */` comment in .ts files; the
//     literal text is minified and `${...}` expressions are left alone
//
// A template's text is minified one piece at a time, between interpolations,
// and nothing is known about what an interpolation will produce, so
// whitespace next to one is kept as a single space. A comment that runs
// across an interpolation is an error rather than guesswork.
import fs from 'node:fs/promises';

const isWord = c => /[A-Za-z0-9_]/.test(c);
// Two operator characters may fuse into a different token (`- -x` vs `--x`).
const isOp = c => '+-*/%&|^<>=!'.includes(c);

/**
 * Minifies a run of WGSL text. `padStart`/`padEnd` keep a space where the
 * text met whitespace next to an interpolation.
 */
function minifyPiece(src, padStart = false, padEnd = false) {
  let out = '';
  let space = false;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      if (nl < 0) {
        return null;
      }
      i = nl;
    } else if (src.startsWith('/*', i)) {
      // WGSL block comments nest.
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= src.length) {
          return null;
        }
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      space = true;
    } else if (/\s/.test(src[i])) {
      space = true;
      i++;
    } else {
      // A backslash is a template-literal escape in TS source; keep it whole.
      const tok = src[i] === '\\' ? src.slice(i, i + 2) : src[i];
      if (space) {
        const a = out[out.length - 1];
        const b = tok[0];
        if (
          out === ''
            ? padStart
            : (isWord(a) && isWord(b)) || (isOp(a) && isOp(b))
        ) {
          out += ' ';
        }
      }
      space = false;
      out += tok;
      i += tok.length;
    }
  }
  if (space && padEnd && out !== '') {
    out += ' ';
  }
  // A piece that is all whitespace between two interpolations.
  if (out === '' && space && padStart && padEnd) {
    out = ' ';
  }
  return out;
}

/** Strips comments and unneeded whitespace from a complete WGSL source. */
export function minifyWgsl(src) {
  // A trailing line comment with no newline still ends the source.
  const out = minifyPiece(src + '\n');
  if (out === null) {
    throw new Error('unterminated block comment in WGSL');
  }
  return out;
}

/** Returns the index of the `}` closing a `${`, given the index after it. */
function skipExpression(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    } else if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i += src[i] === '\\' ? 2 : 1);
    } else if (c === '`') {
      i = skipTemplate(src, i + 1);
    } else if (src.startsWith('//', i)) {
      i = src.indexOf('\n', i);
    } else if (src.startsWith('/*', i)) {
      i = src.indexOf('*/', i + 2) + 1;
    }
    i++;
  }
  throw new Error('unterminated ${ in template literal');
}

/** Returns the index of the backtick closing a template, given the index after the opening one. */
function skipTemplate(src, i) {
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
    } else if (src[i] === '`') {
      return i;
    } else if (src.startsWith('${', i)) {
      i = skipExpression(src, i + 2) + 1;
    } else {
      i++;
    }
  }
  throw new Error('unterminated template literal');
}

/** Minifies the text of every `/* wgsl *\/` tagged template in a TS source. */
export function minifyWgslTemplates(src, file = '<source>') {
  const marker = /\/\*\s*wgsl\s*\*\/\s*`/g;
  let out = '';
  let last = 0;
  for (let m; (m = marker.exec(src));) {
    let i = m.index + m[0].length;
    out += src.slice(last, i);
    let pieceStart = i;
    for (;;) {
      if (i >= src.length) {
        throw new Error(`${file}: unterminated wgsl template literal`);
      }
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      const atEnd = src[i] === '`';
      if (!atEnd && !src.startsWith('${', i)) {
        i++;
        continue;
      }
      const piece = minifyPiece(
        src.slice(pieceStart, i),
        pieceStart !== m.index + m[0].length,
        !atEnd,
      );
      if (piece === null) {
        const line = src.slice(0, i).split('\n').length;
        throw new Error(
          `${file}:${line}: WGSL comment runs into an interpolation or the end of the template`,
        );
      }
      out += piece;
      if (atEnd) {
        i++;
        out += '`';
        break;
      }
      const close = skipExpression(src, i + 2);
      out += src.slice(i, close + 1);
      i = pieceStart = close + 1;
    }
    last = marker.lastIndex = i;
  }
  return out + src.slice(last);
}

/** esbuild plugin: minifies WGSL in .wgsl files and tagged TS templates. */
export const wgslMinifyPlugin = {
  name: 'wgsl-minify',
  setup(build) {
    build.onLoad({filter: /\.wgsl$/}, async args => ({
      contents: minifyWgsl(await fs.readFile(args.path, 'utf8')),
      loader: 'text',
    }));
    build.onLoad({filter: /\.ts$/}, async args => ({
      contents: minifyWgslTemplates(
        await fs.readFile(args.path, 'utf8'),
        args.path,
      ),
      loader: 'ts',
    }));
  },
};
