import {spawn} from 'node:child_process';
import {promises as fs,constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
const worker=fileURLToPath(new URL('./analysis-worker.py',import.meta.url));
const python=process.env.STUDY_ANALYSIS_PYTHON||'/usr/bin/python3';
const MAX_INPUT=2_000_000,MAX_OUTPUT=2_000_000;
async function run(operation,args,file){
  let handle;
  try{
    if(file){handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_MATERIAL_BYTES)throw Error('表格不存在或超过 '+MATERIAL_SIZE_LABEL+'。');}
    const before=handle?await handle.stat():null;
    const payload=JSON.stringify({operation,args,...(handle?{fileFd:3,extension:file.split('.').at(-1)?.toLowerCase()}: {})});
    if(Buffer.byteLength(payload)>MAX_INPUT)throw Error('计算输入过大，请缩小数据范围。');
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(python,['-B',worker],{stdio:['pipe','pipe','pipe',...(handle?[handle.fd]:[])],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}});
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      let stdout='',stderr='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('计算或表格读取超时，请缩小数据范围。'));},15000);
      child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>MAX_OUTPUT){child.kill('SIGKILL');finish(Error('结果过大，请缩小表格范围。'))}});
      child.stderr.on('data',chunk=>{if(stderr.length<500)stderr+=chunk});
      child.on('error',()=>finish(Error('本机计算环境不可用。')));child.on('close',code=>{if(code!==0)return finish(Error('本机计算未完成，请缩小输入或检查数据。'));try{const value=JSON.parse(stdout);value.ok?finish(null,value.result):finish(Error(value.error||'计算未完成。'))}catch{finish(Error('本机计算结果无法读取。'))}});
      child.stdin.on('error',()=>{});child.stdin.end(payload);
    });
    if(handle){const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('资料在读取期间发生变化，请重新读取。');}
    return result;
  }finally{await handle?.close();}
}
export function calculate(args){return run('calculate',args)}
export function analyze(args){return run('analyze',args)}
export function readSpreadsheet(file,args={}){return run('spreadsheet',args,file)}
export function analyzeSpreadsheet(file,args){return run('analyze_spreadsheet',args,file)}
