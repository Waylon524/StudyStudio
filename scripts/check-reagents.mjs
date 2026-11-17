import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleChemistry} from '../server/chemistry.mjs';

async function render(source,kind='reaction'){
  const req=Readable.from([Buffer.from(JSON.stringify({kind,source}))]);req.method='POST';
  let result;
  await handleChemistry(req,{writeHead(){},end(body){result=JSON.parse(body)}},new URL('http://127.0.0.1/api/chem/render'));
  return result;
}
const text=svg=>svg.replace(/<[^>]*>/g,'').replace(/\s+/g,'');
function valid(result){assert(['ok','ok_with_warnings'].includes(result.status),JSON.stringify(result));assert(result.svg?.includes('<svg'));assert.deepEqual(result.audit?.blocking_issues,[]);}

const permanganate=await render('C=CC>[K+].[O-][Mn](=O)(=O)=O.O>CC(O)CO');valid(permanganate);
assert(text(permanganate.svg).includes('KMnO4+H2O'));
assert(!text(permanganate.svg).includes('[K+]'));assert(!text(permanganate.svg).includes('[Mn]'));
const ozone=await render('CC(C)=CC>[O-][O+]=O.CSC>CC(C)=O.CC=O');valid(ozone);
assert(text(ozone.svg).includes('O3+'));assert(!text(ozone.svg).includes('CSC'));
assert.equal((ozone.svg.match(/class="reagent-structure"/g)||[]).length,1);
assert(ozone.audit.bond_geometry.per_element.some(item=>item.label==='reagent'&&item.median_bond_px===24));
const isomers=await render('C=C>CCO.COC>CC');valid(isomers);
assert.equal((isomers.svg.match(/class="reagent-structure"/g)||[]).length,2);
assert(!text(isomers.svg).includes('C2H6O'));
const isotopic=await render('C=C>[18OH2].F[C@H](Cl)Br>CC');valid(isotopic);
assert.equal((isotopic.svg.match(/class="reagent-structure"/g)||[]).length,2);
assert(!text(isotopic.svg).includes('@'));
const python=process.env.STUDY_CHEM_PYTHON||join(homedir(),'.local/share/codex-organic-chem/.venv/bin/python');
const probe=spawnSync(python,['-B','-c',"import json,sys;sys.path.insert(0,sys.argv[1]);from chem_reagents import reagent_parts;print(json.dumps(reagent_parts('[18OH2].F[C@H](Cl)Br')))",fileURLToPath(new URL('../server',import.meta.url))],{encoding:'utf8'});
assert.equal(probe.status,0,probe.stderr);const retained=JSON.parse(probe.stdout);
assert(retained[0].smiles.includes('18'));assert(retained[1].smiles.includes('@'));assert(retained.every(item=>!item.text));
for(const source of ['C1CC1.[H][H]>>CCC','CCO>>CC=O','C=CC>H2/Ni>CCC','C=CC>冷、稀 KMnO4>CC(O)CO'])valid(await render(source));
const labelled=await render({rows:[{items:[{smiles:'CCO'},{type:'arrow',arrow_kind:'equilibrium',reagent_smiles:'[O-][O+]=O.CSC',label:'1. 臭氧化',sublabel:'2. 还原处理'},{smiles:'CC=O'}]}]});valid(labelled);
assert(text(labelled.svg).includes('1.臭氧化'));assert(text(labelled.svg).includes('2.还原处理'));
const equation=await render('2H2 + O2 ->[光照][40°C] 2H2O','equation');valid(equation);assert(text(equation.svg).includes('光照'));
const invalid=await render('C=C>[K+].[bad]>CC');assert.equal(invalid.status,'error');assert(!invalid.svg);
console.log('Reaction reagents passed: real permanganate/water and ozone/DMS inputs; organic isomers/stereo/isotopes retain drawings; hydrogen, legacy prose, labelled equilibrium, equations and invalid structures.');
