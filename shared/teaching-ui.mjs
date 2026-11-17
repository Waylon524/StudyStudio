import {validateStudySpec} from './study-schema.mjs';
import {validateCanvasSpec} from './canvas-schema.mjs';

const types=new Set(['markdown','text','callout','table','steps','tabs','chart','question','canvas']);
export function prepareTeachingSpec(spec){
  if(!spec||typeof spec!=='object'||Array.isArray(spec)||JSON.stringify(spec).length>512000)throw Error('教学组件无效或内容过大。');
  const questions=[],canvases=[],ids=new Set();let count=0;
  function walk(blocks,depth=0){
    if(!Array.isArray(blocks)||!blocks.length||blocks.length>100||depth>5)throw Error('教学组件层级或数量无效。');
    return blocks.map(block=>{
      if(!block||!types.has(block.type)||++count>200)throw Error('教学组件类型或数量无效。');
      if(block.type==='canvas'){
        const canvas=validateCanvasSpec(block);if(ids.has(canvas.id))throw Error('画布 ID 重复。');ids.add(canvas.id);canvases.push(canvas);
        return {type:'canvas',...canvas};
      }
      if(block.type==='question'){questions.push(block.question);return block;}
      if(block.type==='tabs'){
        if(!Array.isArray(block.tabs)||!block.tabs.length||block.tabs.length>10)throw Error('教学标签页无效。');
        return {...block,tabs:block.tabs.map(tab=>({...tab,blocks:walk(tab.blocks,depth+1)}))};
      }
      return block;
    });
  }
  let normalized;
  if(Array.isArray(spec.blocks))normalized={...(spec.id?{id:spec.id}:{}),title:spec.title||'',blocks:walk(spec.blocks)};
  else if(Array.isArray(spec.items)){questions.push(...spec.items);normalized=spec;}
  else throw Error('教学组件需要 items 或 blocks。');
  const questionSpec=questions.length?validateStudySpec({...(spec.id?{id:spec.id}:{}),title:spec.title||'',items:questions}):null;
  if(!questionSpec&&!normalized.blocks?.length)throw Error('教学组件内容为空。');
  return {spec:normalized,questionSpec,canvases};
}
