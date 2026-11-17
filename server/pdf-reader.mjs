import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const bin=name=>path.join(process.env.STUDY_POPPLER_DIR||'/opt/homebrew/bin',name);

export async function pdfInfo(file){
  const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await h.stat();if(!st.isFile()||st.size>MAX_MATERIAL_BYTES)throw Error('PDF 文件不存在或超过 '+MATERIAL_SIZE_LABEL+'。');const magic=Buffer.alloc(5);await h.read(magic,0,5,0);if(magic.toString()!=='%PDF-')throw Error('文件不是可识别的 PDF。');}finally{await h.close()}
  try{const {stdout}=await exec(bin('pdfinfo'),[file],{timeout:12000,maxBuffer:200000});const found=/^Pages:\s*(\d+)\s*$/m.exec(stdout);if(!found||Number(found[1])<1)throw Error('页数不可用');return {pages:Number(found[1])};}catch(e){throw Error('无法读取 PDF 页数：'+String(e.message||'未知错误').slice(0,250));}
}

export async function pdfPage(file,page,cacheDir=os.tmpdir()){
  const {pages}=await pdfInfo(file);if(!Number.isInteger(page)||page<1||page>pages)throw Error('PDF 页码超出范围。');
  const dir=await fs.mkdtemp(path.join(cacheDir,'study-page-')),prefix=path.join(dir,'page');
  const warnings=[];let text='',imagePath=null;
  try{
    try{const result=await exec(bin('pdftotext'),['-f',String(page),'-l',String(page),'-layout',file,'-'],{timeout:12000,maxBuffer:500000});text=result.stdout.slice(0,30000);if(!text.trim())warnings.push('此页没有可提取的文字，未进行 OCR。');if(result.stdout.length>30000)warnings.push('本页提取文字超过 30000 字符，已截断。');}catch{warnings.push('本页文字提取失败；未进行 OCR。');}
    try{await exec(bin('pdftoppm'),['-f',String(page),'-l',String(page),'-singlefile','-scale-to','1600','-png',file,prefix],{timeout:20000,maxBuffer:200000});imagePath=prefix+'.png';await fs.access(imagePath);}catch{warnings.push('本页图像渲染失败。');imagePath=null;}
    return {page,pages,text,imagePath,tempDir:dir,warnings};
  }catch(error){await fs.rm(dir,{recursive:true,force:true});throw error;}
}
