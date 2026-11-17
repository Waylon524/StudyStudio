export function validateCanvasSpec(canvas) {
  if(!canvas || typeof canvas!=='object' || Array.isArray(canvas))throw Error('画布内容无效。');
  if(typeof canvas.id!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(canvas.id))throw Error('画布 ID 无效。');
  if(typeof canvas.title!=='string' || !canvas.title.trim() || canvas.title.length>160)throw Error('画布标题无效。');
  if(typeof canvas.html!=='string' || !canvas.html.trim() || canvas.html.length>120000)throw Error('画布内容必须为 1–120000 个字符。');
  if(canvas.height!==undefined && (!Number.isInteger(canvas.height) || canvas.height<240 || canvas.height>900))throw Error('画布高度必须为 240–900。');
  return {id:canvas.id,title:canvas.title.trim(),html:canvas.html,height:canvas.height??420};
}
