import assert from 'node:assert/strict';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkStrong from '../shared/remark-cjk-strong.mjs';
import remarkSourceCompletion from '../shared/remark-source-completion.mjs';

function parse(source,streaming=true){
  const parser=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCjkStrong).use(remarkSourceCompletion,{streaming});
  return parser.runSync(parser.parse(source),{value:source});
}
function nodes(node,type){return [node,...(node.children||[]).flatMap(child=>nodes(child))].filter(node=>!type||node.type===type)}
function ready(source,type,streaming=true){return nodes(parse(source,streaming),type).map(node=>node.data.hProperties['data-source-ready']==='true')}
const reaction='CCO>>CC=O';
for(const fence of ['```','~~~','````']){
 const opening=fence+'reaction\n'+reaction;
 assert.deepEqual(ready(opening,'code'),[false]);
 assert.deepEqual(ready(opening,'code',false),[false],'an incomplete response cannot execute an unclosed code fence');
 assert.deepEqual(ready(opening+'\n'+fence,'code'),[false],'a live EOF fence might still receive text');
 assert.deepEqual(ready(opening+'\n'+fence,'code',false),[true]);
 assert.deepEqual(ready(opening+'\n'+fence+'  \nMore prose','code'),[true]);
 assert.deepEqual(ready(opening+'\n'+fence+'not a closing fence\n','code'),[false]);
}
assert.deepEqual(ready('````reaction\n'+reaction+'\n```\n','code'),[false]);
assert.deepEqual(ready('```reaction\n'+reaction+'\n    ```\n','code'),[false]);
assert.deepEqual(ready('> ```reaction\n> '+reaction+'\n> ```\n','code'),[true]);
assert.deepEqual(ready('- ```reaction\n  '+reaction+'\n  ```\n','code'),[true]);
const flow='$$\n\\reaction{'+reaction+'}';
assert.deepEqual(ready(flow,'math'),[false]);
assert.deepEqual(ready(flow+'\n$$','math'),[false]);
assert.deepEqual(ready(flow+'\n$$','math',false),[true]);
assert.deepEqual(ready(flow+'\n$$\nMore prose','math'),[true]);
assert.deepEqual(ready(flow+'\n$$not closed\n','math'),[false]);
assert.deepEqual(ready('> $$\n> \\reaction{'+reaction+'}\n> $$\n','math'),[true]);
for(const marker of ['$','$$']){
 const inline=marker+'\\reaction{'+reaction+'}'+marker;
 assert.deepEqual(ready(inline,'inlineMath'),[false]);
 assert.deepEqual(ready(inline,'inlineMath',false),[true]);
 assert.deepEqual(ready(inline+' and more','inlineMath'),[true]);
 assert.deepEqual(ready(inline+'\n','inlineMath'),[true],'single-line dollar math is ready after its following newline');
 assert.deepEqual(ready(inline.slice(0,-marker.length),'inlineMath'),[]);
}
const source='**特别注意：**马氏\n\n```reaction\n'+reaction+'\n```\n继续输出\n\n```study\n{"items":[{"prompt":"**同面（syn）**加成"}]}';
const tree=parse(source),code=nodes(tree,'code');
assert.equal(nodes(tree,'strong').length,1,'CJK strong behavior is retained');
assert.deepEqual(code.map(node=>node.data.hProperties['data-source-ready']),['true','false']);
assert.equal(code[0].position.start.offset,source.indexOf('```reaction'),'source offsets stay unchanged');
assert.equal(code[1].value,'{"items":[{"prompt":"**同面（syn）**加成"}]}','study JSON remains untouched');
console.log('Progressive chemistry source completion: native fence matching, stable live boundaries, math, containers, incomplete sources, CJK, source offsets and study JSON passed.');
