import path from 'node:path';

// Match the reader's existing byte-zero PDF requirement, not the supplied MIME.
export function validateCoursewareUpload({name,data}){
  if(path.extname(name).toLowerCase()!=='.pdf'){
    throw Object.assign(new TypeError(`“${name}”无法添加到课件栏：仅支持 PDF，请先转换为 PDF。`),{status:415});
  }
  const header=data.subarray(0,9).toString('latin1');
  if(!/^%PDF-[0-9]\.[0-9][\t\n\f\r ]/.test(header)){
    throw Object.assign(new TypeError(`“${name}”的内容不是可识别的 PDF，请重新导出为 PDF 后上传。`),{status:415});
  }
}
