import assert from 'node:assert/strict';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkStrong from '../shared/remark-cjk-strong.mjs';

const core=unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const extended=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCjkStrong);
function nodes(tree,type){return [tree,...(tree.children||[]).flatMap(child=>nodes(child))].filter(node=>!type||node.type===type)}
function text(node){return node.value??(node.children||[]).map(text).join('')}
const cases=[
  ['**同面（syn）**加成为主',['同面（syn）']],
  ['通常**反面（anti）**加成',['反面（anti）']],
  ['**特别注意：**马氏规则说的是 **H 和 X 加在哪两个碳上**，本身不决定',['特别注意：','H 和 X 加在哪两个碳上']],
  ['通常**（anti）反面**加成',['（anti）反面']],
  ['| 加成 | 方向 |\n| --- | --- |\n| 硼氢化 | **同面（syn）**加成为主 |\n| 溴化 | 通常**反面（anti）**加成 |',['同面（syn）','反面（anti）']],
  ['[**同面（syn）**加成](study-source:chapter4#page=36)',['同面（syn）']],
  ['**同面（syn）**加成，**反面（anti）**加成。',['同面（syn）','反面（anti）']]
];
for(const [source,wanted] of cases){
  const tree=extended.parse(source);
  assert.deepEqual(nodes(tree,'strong').map(text),wanted,source);
  for(const node of nodes(tree,'strong')){
    const {start,end}=node.position;
    assert.equal(source.slice(start.offset,start.offset+2),'**');
    assert.equal(source.slice(end.offset-2,end.offset),'**');
  }
}
const unchanged=[
  '**bold** and *italic* and __strong__ and _emphasis_',
  '***nested strong emphasis*** and **outer *italic* text**',
  '中文***同面（syn）***加成',
  '中文*（syn）*文字 and 中文__（syn）__文字',
  String.raw`\*\*同面（syn）\*\*加成`,
  '`**同面（syn）**加成` and ``**特别注意：**马氏``',
  '```study\n{"items":[{"prompt":"**同面（syn）**加成"}]}\n```',
  '~~~reaction\n{"caption":"通常**反面（anti）**加成"}\n~~~',
  '    **同面（syn）**加成',
  '$**同面（syn）**x$ and $\\ce{H2 + Cl2 -> 2HCl}$',
  '$$\n**特别注意：**x\n$$',
  '[normal](https://example.com/**syn**) and ![image](image.png)',
  'a ** b ** c and 2 ** 3 ** 4',
  '**同面（syn） **加成',
  '**incomplete',
  '~~strikethrough~~ and **normal bold**'
];
for(const source of unchanged)assert.deepEqual(extended.parse(source),core.parse(source),'protected/common syntax: '+source);
const nested=extended.parse('*外层 **同面（syn）**加成*');
assert.equal(nodes(nested,'emphasis').length,1);assert.deepEqual(nodes(nested,'strong').map(text),['同面（syn）']);
const source='**特别注意：**马氏\n\n```study\n{"items":[]}\n```';
assert.equal(nodes(extended.parse(source),'code')[0].position.start.offset,source.indexOf('```study'));
for(let end=0;end<='**同面（syn）**加成'.length;end++){
  const source='**同面（syn）**加成'.slice(0,end),tree=extended.parse(source);
  if(end<11)assert.equal(nodes(tree,'strong').length,0,'unfinished double-star span');
  else assert.deepEqual(nodes(tree,'strong').map(text),['同面（syn）']);
}
console.log('Markdown CJK strong: '+cases.length+' repaired examples; '+unchanged.length+' unchanged syntax cases; nesting, offsets and streamed prefixes passed.');
