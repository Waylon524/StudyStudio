import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {handleChemistry} from '../server/chemistry.mjs';

async function render(kind, source) {
  const req=Readable.from([Buffer.from(JSON.stringify({kind,source}))]);req.method='POST';
  let result;
  await handleChemistry(req,{writeHead(){},end(body){result=JSON.parse(body)}},new URL('http://127.0.0.1/api/chem/render'));
  return result;
}
// Exercise the same route endpoint as saved answers, including hydrogen-only
// species, isotope labels and atom maps, plus an ordinary reaction control.
for(const source of ['C1CC1.[H][H]>Ni, 40°C>CCC','C1CC1.[2H][2H]>>[2H]CCC[2H]','[H:1][H:2]>>[H:1].[H:2]','C1CC1.BrBr>>BrCCCBr','CCO>>CC=O']){
  const result=await render('reaction',source);
  assert.equal(result.status,'ok',JSON.stringify({source,warnings:result.warnings,audit:result.audit}));
  assert.ok(result.svg?.includes('<svg'));
  assert.doesNotMatch(result.svg,/NaN|Infinity/i);
  assert.deepEqual(result.audit?.blocking_issues,[]);
}
const bad=await render('reaction','not-a-molecule.[H][H]>>CCC');
assert.equal(bad.status,'error');assert.ok(!bad.svg);
console.log('Hydrogen route regression passed: finite geometry, hydrogen/isotope/atom-map species, ordinary reactions and invalid-input rejection.');
