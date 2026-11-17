import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createChemistryRenderQueue} from '../shared/chemistry-render-queue.mjs';

let running=0,peak=0,calls=[];const pending=new Map();
const queue=createChemistryRenderQueue(async(kind,source)=>{
  calls.push(source);running++;peak=Math.max(peak,running);
  try{return await new Promise((resolve,reject)=>pending.set(source,{resolve,reject}));}finally{running--;}
});
const a=queue.render('reaction','a'),b=queue.render('reaction','b'),c=queue.render('reaction','c'),d=queue.render('reaction','d');
assert.equal(queue.render('reaction','a'),a,'same diagram shares its in-flight request');
await tick();assert.deepEqual(calls,['a','b']);assert.equal(peak,2);
pending.get('a').resolve({svg:'<svg>a</svg>'});await a;await tick();assert.deepEqual(calls,['a','b','c']);
pending.get('b').resolve({svg:'<svg>b</svg>'});await b;await tick();assert.deepEqual(calls,['a','b','c','d']);
pending.get('c').resolve({svg:'<svg>c</svg>'});pending.get('d').resolve({svg:'<svg>d</svg>'});await Promise.all([c,d]);await tick();assert.equal(peak,2);assert.equal(running,0);
assert.equal((await queue.render('reaction','a')).svg,'<svg>a</svg>');assert.equal(calls.length,4);

let loads=0;const bounded=createChemistryRenderQueue(async(kind,source)=>({svg:kind+source+(++loads)}),{maxEntries:2,maxBytes:1000});
await bounded.render('reaction','a');await bounded.render('reaction','b');assert.ok(bounded.peek('reaction','a'));
await bounded.render('reaction','c');assert.equal(bounded.peek('reaction','b'),undefined,'least recently used completed drawing is evicted');
await bounded.render('reaction','b');assert.equal(loads,4);
const bytes=createChemistryRenderQueue(async()=>({svg:'x'.repeat(30)}),{maxBytes:20});
assert.ok((await bytes.render('molecule','large')).svg);assert.equal(bytes.peek('molecule','large'),undefined,'oversized result is shown without keeping a second cache copy');

let attempts=0;const retries=createChemistryRenderQueue(async()=>{if(++attempts===1)throw Error('temporary');return {svg:'recovered'};});
await assert.rejects(retries.render('reaction','retry'),/temporary/);assert.equal((await retries.render('reaction','retry')).svg,'recovered');assert.equal(attempts,2);
console.log('Chemistry render queue passed: bounded concurrency, shared requests, warm reuse, LRU/byte limits and failed-request retry.');
