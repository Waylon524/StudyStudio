import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleChemistry } from '../server/chemistry.mjs';
import { parseChemicalEquation, parseChemicalFormula, formatChemicalSpecies, chemicalEquationFromMath } from '../shared/chemical-equation.mjs';

async function render(kind, source) {
  const req = Readable.from([Buffer.from(JSON.stringify({ kind, source }))]);
  req.method = 'POST';
  let result;
  await handleChemistry(req, { writeHead() {}, end(body) { result = JSON.parse(body); } }, new URL('http://127.0.0.1/api/chem/render'));
  return result;
}

const textMatches = (svg, regex) => [...svg.matchAll(regex)];
const allText = svg => svg.replace(/<[^>]*>/g, '').replace(/\s+/g, '');

// 1. Plain SMILES preserves selective explicit [H] without expanding implicit H's.
const alkyne = await render('molecule', 'OC(C)(C)C#C[H]');
assert.equal(alkyne.status, 'ok', JSON.stringify(alkyne));
assert.ok(alkyne.svg.includes('<svg'));
// Expect exactly two 'H' text glyphs: one in 'HO' (atom-0) and one explicit terminal H (atom-6).
const alkyneHs = textMatches(alkyne.svg, /<text[^>]*class="atom-(\d+)"[^>]*>H<\/text>/g).map(m => Number(m[1]));
assert.deepEqual(alkyneHs.sort((a, b) => a - b), [0, 6], 'only OH and explicit terminal [H] should draw H');

const arylVinyl = await render('molecule', 'Clc1ccc(\\C([H])=C(/[H])OC)c([H])c1');
assert.equal(arylVinyl.status, 'ok', JSON.stringify(arylVinyl));
const arylHs = textMatches(arylVinyl.svg, /<text[^>]*class="atom-(\d+)"[^>]*>H<\/text>/g);
assert.equal(arylHs.length, 3, 'exactly 3 selective explicit [H] atoms (1 ortho + 2 vinyl) should be drawn');

// All-hydrogen species and single ions remain safe in standalone molecule mode.
for (const edge of ['[H][H]', '[2H][2H]', '[H+]', '[OH-]']) {
  const r = await render('molecule', edge);
  assert.equal(r.status, 'ok', `${edge}: ${JSON.stringify(r)}`);
  assert.doesNotMatch(r.svg, /NaN|Infinity/i);
}

// 2. Plain reaction SMILES preserves selective explicit [H].
const rxnH = await render('reaction', 'CC([H])(Br)C>[OH-]>C=CC.O.[Br-]');
assert(['ok', 'ok_with_warnings'].includes(rxnH.status), JSON.stringify(rxnH));
assert.deepEqual(rxnH.audit?.blocking_issues, []);
assert.match(rxnH.svg, /class="bond-1 atom-1 atom-2"/, 'explicit C-H bond retained in reaction SVG');
assert.match(rxnH.svg, /class="atom-2"/, 'explicit H glyph retained in reaction SVG');

// 3. Annotated molecule JSON: selective H + show_carbons + labels + bare & labelled pointers + caption.
const example3 = await render('molecule', {
  smiles: 'Clc1ccc(\\C([H:2])=C(/[H:3])O[CH3:4])c([H:1])c1',
  show_carbons: 'non_ring',
  caption: '(3)',
  annotations: [
    { type: 'label', atom_map: 1, text: 'a', position: 'bottom' },
    { type: 'pointer', atom_map: 2, text: 'b', position: 'bottom-right' },
    { type: 'label', atom_map: 3, text: 'c', position: 'left' },
    { type: 'label', atom_map: 4, text: 'd', position: 'top' },
  ],
});
assert.equal(example3.status, 'ok', JSON.stringify(example3));
assert.ok(example3.svg.includes('chem-annotation-arrow'));
assert.ok(example3.svg.includes('chem-annotation-head'));
assert.ok(example3.svg.includes('chem-caption'));
assert.ok(!allText(example3.svg).includes(':1'), 'atom map numbers are hidden by default when used as annotation anchors');
for (const lbl of ['a', 'b', 'c', 'd', '(3)']) {
  assert.ok(allText(example3.svg).includes(lbl), `missing label ${lbl}`);
}

// Bare downward pointer arrow + show_carbons: "all" (like textbook example 1).
const example1 = await render('molecule', {
  smiles: '[CH3:1]OC(=O)[CH2:2]C(=O)[CH3:3]',
  show_carbons: 'all',
  annotations: [
    { type: 'label', atom_map: 1, text: 'a', position: 'bottom' },
    { type: 'label', atom_map: 2, text: 'b', position: 'bottom' },
    { type: 'pointer', atom_map: 2, position: 'top' },
    { type: 'label', atom_map: 3, text: 'c', position: 'bottom' },
  ],
});
assert.equal(example1.status, 'ok', JSON.stringify(example1));
assert.ok(example1.svg.includes('chem-annotation-arrow'));
assert.ok(allText(example1.svg).includes('CH2'));

// 4. Map-based selective H expansion: partial count dict, atom list, and "all".
const splitOne = await render('molecule', {
  smiles: 'CC(=O)[CH2:1]C(=O)C',
  explicit_h: { '1': 1 },
  show_carbons: [1],
  annotations: [{ type: 'pointer', atom_map: 1, text: '活性亚甲基', color: 'red' }],
});
assert.equal(splitOne.status, 'ok', JSON.stringify(splitOne));
assert.ok(allText(splitOne.svg).includes('活性亚甲基'));
// Carbon 1 now has 1 explicit bonded H and 1 remaining H (shown as CH).
const splitOneHs = textMatches(splitOne.svg, /<text[^>]*class="atom-(\d+)"[^>]*>H<\/text>/g);
assert.equal(splitOneHs.length, 2, '1 H inside CH label + 1 split-out explicit H bond');

const splitAll = await render('molecule', { smiles: 'CC', explicit_h: 'all' });
assert.equal(splitAll.status, 'ok', JSON.stringify(splitAll));
assert.equal(textMatches(splitAll.svg, /<text[^>]*>H<\/text>/g).length, 6, 'ethane explicit_h:"all" renders all 6 H atoms');

const splitList = await render('molecule', { smiles: '[CH3:1][CH2:2]O', explicit_h: [2] });
assert.equal(splitList.status, 'ok', JSON.stringify(splitList));
assert.equal(textMatches(splitList.svg, /<text[^>]*>H<\/text>/g).length, 3, '2 split H on C2 + 1 H on OH');

// 5. Bond highlight + bond pointer + rich superscript/subscript + connectors (dashed & curved).
const bondAnnotated = await render('molecule', {
  smiles: 'CC(=[O:3])[O:1][CH2:2]C',
  show_carbons: 'methyl',
  annotations: [
    { type: 'highlight', bond: [1, 2], color: 'red' },
    { type: 'pointer', bond: [1, 2], text: '此处断键', position: 'bottom', color: 'red' },
    { type: 'label', atom_map: 3, text: 'δ-', position: 'top', color: 'blue' },
  ],
});
assert.equal(bondAnnotated.status, 'ok', JSON.stringify(bondAnnotated));
assert.ok(bondAnnotated.svg.includes('chem-annotation-highlight'));
assert.ok(bondAnnotated.svg.includes('#c0392b'));
assert.ok(bondAnnotated.svg.includes('#1d4ed8'));
assert.ok(allText(bondAnnotated.svg).includes('此处断键'));

const curvedNoe = await render('molecule', {
  smiles: 'C/C([H:1])=C(/[H:2])C',
  annotations: [
    { type: 'connector', from_atom_map: 1, to_atom_map: 2, style: 'curved_double_arrow', text: 'NOE', color: 'purple' },
    { type: 'highlight', atom_map: 1, style: 'dashed_circle', color: 'green' },
    { type: 'label', atom_map: 1, text: 'H_a' },
  ],
});
assert.equal(curvedNoe.status, 'ok', JSON.stringify(curvedNoe));
assert.ok(curvedNoe.svg.includes('chem-annotation-connector'));
assert.ok(curvedNoe.svg.includes('Q '), 'curved connector uses quadratic Bezier path');
assert.ok(allText(curvedNoe.svg).includes('NOE'));

// 6. Annotated molecule inside a reaction route JSON passes publication audit with 24px uniform bonds.
const annotatedRoute = await render('reaction', {
  rows: [{
    items: [
      {
        smiles: 'CC([H:1])C([Br:2])C',
        annotations: [
          { type: 'pointer', atom_map: 1, text: 'β-H', color: 'red' },
          { type: 'highlight', atom_map: 1, style: 'halo', color: 'red' },
          { type: 'label', atom_map: 2, text: '离去基', color: 'blue' },
        ],
      },
      { type: 'arrow', reagent_smiles: '[Na+].[OH-]', label: 'E2 消除', sublabel: '加热' },
      { smiles: 'CC=CC' },
    ],
  }],
});
assert(['ok', 'ok_with_warnings'].includes(annotatedRoute.status), JSON.stringify(annotatedRoute));
assert.deepEqual(annotatedRoute.audit?.blocking_issues, []);
assert.ok(annotatedRoute.svg.includes('chem-annotation-arrow'));
assert.ok(allText(annotatedRoute.svg).includes('β-H'));
assert.ok(allText(annotatedRoute.svg).includes('离去基'));
assert.equal(annotatedRoute.audit.bond_geometry.min_median_bond_px, 24);
assert.equal(annotatedRoute.audit.bond_geometry.max_median_bond_px, 24);

// 7. Chemical equations with radicals (\bullet), radical cations, bond dashes, photochemistry (h\nu), and standalone formula kind.
for (const eq of [
  '[C4H9Br]^{+\\bullet} -> C4H9+ + Br^\\bullet',
  'C4H9—Br ->[e^-] [C4H9Br]^{+\\bullet} + e-',
  'C4H9-Br ->[e^-] C4H9-Br^{+\\bullet} + e^-',
  'Br2 ->[h\\nu] 2Br\\bullet',
  'R-H + Br^\\bullet -> R^\\bullet + HBr',
  'CuSO4\\cdot 5H2O ->[\\Delta] CuSO4 + 5H2O',
]) {
  const eqRes = await render('equation', eq);
  assert.equal(eqRes.status, 'ok', `${eq}: ${JSON.stringify(eqRes)}`);
  assert.ok(eqRes.svg?.includes('<svg'));
  assert.deepEqual(eqRes.audit?.blocking_issues, []);
}
assert.equal(formatChemicalSpecies('[C4H9Br]^{+\\bullet}'), '[C₄H₉Br]⁺•');
assert.equal(formatChemicalSpecies('Br^\\bullet'), 'Br•');
assert.equal(formatChemicalSpecies('C4H9-Br'), 'C₄H₉–Br');
assert.equal(formatChemicalSpecies('CuSO4\\cdot 5H2O'), 'CuSO₄· 5H₂O');
assert.equal(formatChemicalSpecies('CuSO4\\cdot5H2O'), 'CuSO₄·5H₂O');
assert.equal(chemicalEquationFromMath('\\ce{[C4H9Br]^{+\\bullet} -> C4H9+ + Br^\\bullet}')?.kind, 'equation');
assert.equal(chemicalEquationFromMath('\\ce{[C4H9Br]^{+\\bullet}}'), null, 'formula-only ce remains inline in KaTeX for Markdown');
assert.throws(() => parseChemicalEquation('H2+O2 -> H2O'), /空格/);

const formulaRes = await render('formula', '[C4H9Br]^{+\\bullet}');
assert.equal(formulaRes.status, 'ok', JSON.stringify(formulaRes));
assert.ok(formulaRes.svg?.includes('<svg'));
assert.deepEqual(formulaRes.audit?.blocking_issues, []);
assert.equal(parseChemicalFormula('C4H9—Br').rows[0].items[0].text, 'C₄H₉—Br');

// 8. Strict error handling on invalid specs.
const invalidCases = [
  ['molecule', { smiles: 'CCO', annotations: [{ type: 'label', atom_map: 9, text: 'a' }] }],
  ['molecule', { smiles: '[CH3:1][CH2:2][OH:3]', annotations: [{ type: 'pointer', bond: [1, 3], text: 'bad' }] }],
  ['molecule', { smiles: '[CH3:1]C[CH3:1]', annotations: [{ type: 'label', atom_map: 1, text: 'dup' }] }],
  ['molecule', { smiles: 'CC(=O)[CH2:1]C', explicit_h: { '1': 5 } }],
  ['molecule', { smiles: '[CH3:1]O', annotations: [{ type: 'label', atom_map: 1, text: 'a', color: 'javascript:alert(1)' }] }],
  ['molecule', { smiles: '[CH3:1]O', annotations: [{ type: 'label', atom_map: 1, text: 'a', position: 'sideways' }] }],
  ['molecule', { smiles: 'CCO>>CC=O' }],
];
for (const [kind, spec] of invalidCases) {
  const res = await render(kind, spec);
  assert.equal(res.status, 'error', `Expected error for ${JSON.stringify(spec)}, got ${JSON.stringify(res)}`);
  assert.ok(!res.svg);
}

console.log('Chemistry selective-H, annotations, radicals & formula regression passed.');
