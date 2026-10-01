import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- build script, no type declarations
import {minifyWgsl, minifyWgslTemplates} from '../../scripts/wgsl-minify.mjs';

test('minifyWgsl strips comments and whitespace', () => {
  assert.equal(
    minifyWgsl(
      '// c\n@vertex fn f(a: f32) -> f32 {\n  /* x /* nested */ y */\n  let b = a - -1.0;\n  return b; // end\n}',
    ),
    '@vertex fn f(a:f32)->f32{let b=a- -1.0;return b;}',
  );
});

test('minifyWgslTemplates keeps interpolations and untagged templates', () => {
  const src =
    'const s = /* wgsl */ `\n  fn ${name}() { // hi\n  ${body} }\n  ${a} ${b}\n`;' +
    ' const q = `keep  this`;';
  assert.equal(
    minifyWgslTemplates(src),
    'const s = /* wgsl */ `fn ${name}(){ ${body} } ${a} ${b}`;' +
      ' const q = `keep  this`;',
  );
});

test('minifyWgslTemplates skips nested templates in interpolations', () => {
  const src = '/* wgsl */ `a ${x ? `}  //` : "`"}  b`';
  assert.equal(
    minifyWgslTemplates(src),
    '/* wgsl */ `a ${x ? `}  //` : "`"} b`',
  );
});

test('minifyWgslTemplates rejects a comment across an interpolation', () => {
  assert.throws(() => minifyWgslTemplates('/* wgsl */ `// a ${x}\n`'));
});
