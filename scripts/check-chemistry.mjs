import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { handleChemistry } from '../server/chemistry.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`../public/examples/${name}.json`, import.meta.url), 'utf8'));
const run = async (kind, source) => {
  const req = Readable.from([Buffer.from(JSON.stringify({kind, source}))]); req.method = 'POST';
  let payload;
  const res = {writeHead() {}, end(body) { payload = JSON.parse(body); }};
  await handleChemistry(req, res, new URL('http://127.0.0.1/api/chem/render'));
  return payload;
};
  for (const [kind, source] of [['molecule','CCO'], ['reaction', await fixture('reaction')], ['reaction','CCO>>CC=O'], ['mechanism', await fixture('mechanism')]]) {
    const result = await run(kind, source);
    if (!result.svg?.includes('<svg') || result.status !== 'ok' || (kind === 'mechanism' && result.validation?.semantic_checks?.status !== 'valid')) throw Error(`${kind}: ${JSON.stringify({status:result.status,warnings:result.warnings,validation:result.validation?.semantic_checks})}`);
    console.log(`${kind}: ${result.status}`);
  }
  const bad = await run('molecule', 'not a smiles');
  if (bad.status !== 'error' || bad.svg) throw Error('Invalid molecule was not rejected');
  console.log('invalid input: rejected');
  const blocked = await fixture('mechanism');
  const aromatic = '[CH2:2]([Br:3])[c:4]1[cH:5][cH:6][cH:7][cH:8][cH:9]1';
  const product = '[OH:1][CH2:2][c:4]1[cH:5][cH:6][cH:7][cH:8][cH:9]1';
  const panel = blocked.panels[0];
  panel.starting_state.reaction_smiles = '[OH-:1].' + aromatic;
  panel.expected_state.reaction_smiles = product + '.[Br-:3]';
  panel.molecules[1].smiles = aromatic; panel.molecules[2].smiles = product;
  const blockedResult = await run('mechanism', blocked);
  if (blockedResult.status !== 'blocked_for_publication' || blockedResult.validation?.semantic_checks?.status !== 'unsupported') throw Error('Unsupported mechanism was not flagged');
  console.log('unsupported aromatic mechanism: flagged');
