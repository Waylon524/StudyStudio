// Observe otherwise unhandled native delimiter tokens. The parser alone decides
// whether a fence closes, including container indentation and fence length.
function recordFence(token){
  const type=token.type==='codeFencedFenceSequence'?'code':'math';
  const node=this.stack.findLast(item=>item.type===type);
  if(!node)return;
  const data=node.data||(node.data={});
  const fences=data.studySourceFences||(data.studySourceFences=[]);
  fences.push(token.end.offset);
}
function sourceReady(node,source,streaming){
  if(node.type==='inlineMath'){
    // An inlineMath node is only emitted for matched delimiters. At the live
    // tail, another dollar could still extend the closing delimiter run.
    return !streaming||node.position?.end?.offset<source.length;
  }
  const fences=node.data?.studySourceFences;
  if(fences?.length!==2)return false;
  // An EOF closing fence may still receive trailing text in the next delta.
  return !streaming||/^[ \t]*(?:\r\n|\r|\n)/.test(source.slice(fences[1]));
}
export default function remarkSourceCompletion({streaming=false}={}){
  const data=this.data();
  (data.fromMarkdownExtensions||(data.fromMarkdownExtensions=[])).push({exit:{
    codeFencedFenceSequence:recordFence,mathFlowFenceSequence:recordFence
  }});
  return (tree,file)=>{
    const source=String(file.value);
    function visit(node){
      if(['code','math','inlineMath'].includes(node.type)){
        node.data||(node.data={});node.data.hProperties||(node.data.hProperties={});
        node.data.hProperties['data-source-ready']=sourceReady(node,source,streaming)?'true':'false';
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
