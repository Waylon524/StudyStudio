import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {MAX_MATERIAL_BYTES} from '../shared/file-limits.mjs';

const exec=promisify(execFile),helper=fileURLToPath(new URL('./epub_visual.py',import.meta.url));
const imagePrefix='epub-image:',sectionPrefix='epub-section:';
function relative(value){return typeof value==='string'&&value.length>0&&value.length<=3000&&!value.startsWith('/')&&!/[\\\x00-\x1f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');}
function pointer(prefix,value){return prefix+Buffer.from(JSON.stringify(value)).toString('base64url');}
function decode(value,prefix){
 if(typeof value!=='string'||!value.startsWith(prefix))return null;
 const token=value.slice(prefix.length);if(!/^[A-Za-z0-9_-]{1,26000}$/.test(token))throw Error('EPUB 资料定位无效。');
 let result;try{const data=Buffer.from(token,'base64url');if(data.toString('base64url')!==token)throw Error();result=JSON.parse(data.toString('utf8'));}catch{throw Error('EPUB 资料定位无效。');}
 if(!result||Array.isArray(result)||!relative(result.path)||!/\.epub$/i.test(result.path))throw Error('EPUB 文件定位无效。');
 if(prefix===imagePrefix){if(!relative(result.member)||result.member.length>1500||Object.keys(result).some(key=>!['path','member','section'].includes(key)))throw Error('EPUB 图片定位无效。');}
 else if(Object.keys(result).some(key=>!['path','section'].includes(key)))throw Error('EPUB 分节定位无效。');
 if((prefix===sectionPrefix||result.section!==undefined)&&(!Number.isInteger(result.section)||result.section<1||result.section>10000))throw Error('EPUB 分节序号无效。');
 return result;
}
export const decodeEpubImagePath=value=>decode(value,imagePrefix);
export const decodeEpubSectionPath=value=>decode(value,sectionPrefix);
async function run(file,options){
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_MATERIAL_BYTES)throw Error('EPUB 文件不存在或超过 100 MB。');}finally{await handle.close();}
 const {stdout}=await exec(process.env.STUDY_EXTRACT_PYTHON||'/usr/bin/python3',['-B',helper,file,JSON.stringify(options)],{timeout:45000,maxBuffer:40*1024*1024});
 const result=JSON.parse(stdout);if(result.error)throw Error(result.error);return result;
}
function decorate(result,relativePath){
 if(!relative(relativePath)||!/\.epub$/i.test(relativePath))throw Error('缺少有效 EPUB 相对路径。');
 if(Array.isArray(result.sections))for(const entry of result.sections){entry.path=relativePath;entry.page=entry.section;entry.imageListPath=pointer(sectionPrefix,{path:relativePath,section:entry.section});}
 if(result.section)result.imageListPath=pointer(sectionPrefix,{path:relativePath,section:result.section});
 if(Array.isArray(result.imageRefs))for(const entry of result.imageRefs)entry.path=pointer(imagePrefix,{path:relativePath,member:entry.member,...(result.section?{section:result.section}:{})});
 if(Array.isArray(result.images))result.images=result.images.map(({base64,...image})=>({...image,data:Buffer.from(base64,'base64')}));
 return {...result,relativePath};
}
export async function listEpub(file,{relativePath,offset=0,limit=40,section}={}){
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw Error('EPUB 列表范围无效。');
 if(section!==undefined&&(!Number.isInteger(section)||section<1))throw Error('EPUB 分节序号无效。');
 return decorate(await run(file,{mode:'list',offset,limit,section}),relativePath);
}
export async function readEpub(file,{relativePath,section,imageRef}={}){
 if(section!==undefined&&(!Number.isInteger(section)||section<1))throw Error('EPUB 分节序号无效。');
 if(imageRef!==undefined&&!relative(imageRef))throw Error('EPUB 图片定位无效。');
 return decorate(await run(file,{mode:'read',section,imageRef}),relativePath);
}
