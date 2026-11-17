// A terminal answer is distinct from progress narration and partial answers.
export function finalAssistantItems(items) {
  const messages=(Array.isArray(items)?items:[]).filter(item=>item?.type==='agentMessage');
  const final=messages.filter(item=>item.phase==='final_answer');
  if(final.length)return final.slice(-1);
  return messages.filter(item=>item.phase==null).slice(-1);
}
