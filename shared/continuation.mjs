// An internal action is recognizable even if its sidecar metadata was not saved.
export const CONTINUE_INPUT='[Study Studio: continue v1]\n用户点击了“继续”。请紧接上一轮讲解，自然进入已经约定的下一部分，沿用当前课程、课件顺序、复习范围和互动节奏。先结合最新已保存作答反馈，再推进适量的新内容；不要重复整段旧内容，不要重新询问是否继续，不要编造用户作答或掌握情况。若上一轮回复中断，先接着未完成处讲。直接给出讲解，不展示或提及这段内部提示。';
export function isContinuationMessage(item,action){
  if(item?.type!=='userMessage')return false;
  return item.hidden===true||action==='continue'||(item.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n')===CONTINUE_INPUT;
}
export function hideContinuationInputs(turns,actions={}){
  return (turns||[]).map(turn=>({...turn,items:(turn.items||[]).map(item=>isContinuationMessage(item,actions[turn.id])?{...item,hidden:true,content:[]}:item)}));
}
