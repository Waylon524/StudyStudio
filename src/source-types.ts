type FileLike={name:string;mime?:string;kind?:string}

export const isPdfSource=(source:FileLike)=>source.mime==='application/pdf'||/\.pdf$/i.test(source.name)
export const isMarkdownSource=(source:FileLike)=>source.mime==='text/markdown'||/\.(?:md|markdown)$/i.test(source.name)
export const isHtmlSource=(source:FileLike)=>source.mime==='text/html'||/\.html?$/i.test(source.name)
export const isImageSource=(source:FileLike)=>Boolean(source.mime?.startsWith('image/')||/\.(?:png|jpe?g|webp|gif)$/i.test(source.name))
export const isSlidesSource=(source:FileLike)=>/\.pptx?$/i.test(source.name)
export const isSpreadsheetSource=(source:FileLike)=>/\.(?:xlsx?|xlsm|csv|tsv)$/i.test(source.name)
export const isEpubSource=(source:FileLike)=>/\.epub$/i.test(source.name)
export const isReadableCoursewareSource=(source:FileLike)=>source.kind==='courseware'&&isPdfSource(source)
export const isRightReaderSource=(source:FileLike)=>isPdfSource(source)||isMarkdownSource(source)||isHtmlSource(source)
