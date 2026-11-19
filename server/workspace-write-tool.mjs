const MAX_TURN_WRITES=12,MAX_TOOL_CALLS=32;
const allowedKeys=new Set(['path','content','overwrite']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export const workspaceWriteTool={
  name:'study_workspace_write',
  description:'在当前课程工作区的资料目录中创建（或更新由你创建的）学习资料文件（支持 .md、.html、.txt、.csv、.tsv、.json、.tex），例如复习笔记、知识点总结、反应机理汇总、错题清单或自包含交互式 HTML 页面。保存后立即出现在课程「资料」栏，其中 Markdown 与 HTML 可直接在右侧阅读器中打开（Markdown 支持 KaTeX、\\ce{} 与化学结构式/反应式代码块，HTML 运行在离线沙箱中）。禁止写入系统文件（AGENTS.md、学习进度.md、课程重要信息.md）、禁止覆盖用户上传原件、禁止写入「课件/」或「待整理/」。推荐使用清晰子目录，如 笔记/主题.md 或 互动页面/主题.html。成功返回后可用返回的 citation [文件名](study-source:ID) 引用该文件，方便学习者一键在右侧阅读器打开。',
  inputSchema:{
    type:'object',
    properties:{
      path:{type:'string',maxLength:400,description:'课程内相对文件路径，如 笔记/热力学总结.md 或 互动页面/滴定曲线.html'},
      content:{type:'string',maxLength:500000,description:'UTF-8 文本内容（不超过 500 KB）'},
      overwrite:{type:'boolean',description:'是否更新已存在的、由 Agent 之前创建的同名文件；默认 false，绝不覆盖用户上传原件'}
    },
    required:['path','content'],
    additionalProperties:false
  }
};

function prepare(args){
  if(!record(args)||Object.keys(args).some(key=>!allowedKeys.has(key)))throw new TypeError('创建资料文件参数无效，仅支持 path、content 和可选 overwrite。');
  if(typeof args.path!=='string'||!args.path.trim())throw new TypeError('请提供有效的文件路径，例如 笔记/总结.md。');
  if(typeof args.content!=='string'||!args.content.trim())throw new TypeError('文件内容不能为空。');
  if(args.overwrite!==undefined&&typeof args.overwrite!=='boolean')throw new TypeError('overwrite 参数必须为布尔值。');
  return {path:args.path.trim(),content:args.content,overwrite:args.overwrite===true};
}

export async function writeWorkspaceFileForAgent({store,course,active,args,callId,write,onUpdate,isActive}){
  if(!active||active.course?.id!==course.id||!isActive())throw new Error('本轮对话已经结束，未写入资料文件。');
  if(typeof callId!=='string'||!callId||callId.length>200)throw new TypeError('文件写入工具调用编号无效。');
  const request=prepare(args);
  active.workspaceWriteCalls ||= new Map();
  if(active.workspaceWriteCalls.has(callId))return active.workspaceWriteCalls.get(callId);
  if(active.workspaceWriteCalls.size>=MAX_TOOL_CALLS)throw new TypeError('本轮文件写入调用次数已达到上限。');
  if((active.workspaceWriteCount||0)>=MAX_TURN_WRITES)throw new TypeError('本轮最多创建或更新 12 份资料文件，请先完成当前回复。');
  active.workspaceWriteCount=(active.workspaceWriteCount||0)+1;
  const task=Promise.resolve().then(()=>write(async()=>{
    if(!isActive())throw new Error('本轮对话已经结束，未写入资料文件。');
    const result=await store.writeWorkspaceFile(course,request);
    try{onUpdate(course)}catch{/* Saving succeeded even if an SSE subscriber has disconnected. */}
    const {source,...summary}=result;
    return {saved:true,...summary};
  })).catch(error=>{active.workspaceWriteCount--;throw error;});
  active.workspaceWriteCalls.set(callId,task);
  return task;
}
