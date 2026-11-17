import json
import os
import sys
sys.dont_write_bytecode = True
import zipfile
import xml.etree.ElementTree as ET

path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
MAX_MATERIAL_BYTES = 100 * 1024 * 1024
MAX_XML_BYTES = 60 * 1024 * 1024
limit = 100000
warnings = []
page_limit_reached = False
try:
    if os.path.getsize(path) > MAX_MATERIAL_BYTES:
        raise ValueError('文件超过 100 MB，未提取文本。')
    if ext in ('.txt','.md','.csv','.json','.tex','.tsv'):
        with open(path, encoding='utf-8-sig') as f: text = f.read(limit + 1)
    elif ext == '.pdf':
        try:
            from pypdf import PdfReader
            reader = PdfReader(path)
            if reader.is_encrypted: raise ValueError('PDF 已加密，无法提取。')
            if len(reader.pages) > 100:
                page_limit_reached = True
                warnings.append(f'PDF 共 {len(reader.pages)} 页，仅提取前 100 页。')
            parts = []
            for i, page in enumerate(reader.pages[:100]):
                parts.append(f'\n[第 {i+1} 页]\n' + (page.extract_text() or ''))
                if sum(map(len, parts)) > limit: break
            text = ''.join(parts)
        except ImportError:
            import subprocess, shutil
            binary = shutil.which('pdftotext') or next((p for p in ['/opt/homebrew/bin/pdftotext','/usr/local/bin/pdftotext'] if os.path.isfile(p)),None)
            if not binary: raise ValueError('未找到可用的 PDF 文本提取器。')
            p = subprocess.run([binary,'-f','1','-l','100',path,'-'],capture_output=True,timeout=12,check=True)
            text = p.stdout.decode('utf-8',errors='replace')
            page_limit_reached = True
            warnings.append('PDF 文本提取最多检查前 100 页；未核实总页数。')
        if len(''.join(text.split())) < 40: raise ValueError('PDF 可提取的文字很少，可能是扫描件；未进行 OCR。')
    elif ext == '.epub':
        from epub_extract import read_epub
        result = read_epub(path, limit)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)
    elif ext in ('.xlsx', '.xlsm'):
        from analysis_spreadsheet import read_spreadsheet
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as file:
            if os.fstat(file.fileno()).st_size > MAX_MATERIAL_BYTES:
                raise ValueError('文件超过 100 MB，未提取文本。')
            directory = read_spreadsheet(file, ext[1:], {})
            first = directory['sheets'][0]['name']
            file.seek(0)
            preview = read_spreadsheet(file, ext[1:], {'sheet': first, 'range': 'A1:L30', 'rowLimit': 30, 'columnLimit': 12})
        lines = ['Excel 工作表：' + '、'.join(item['name'] for item in directory['sheets']), '首张工作表预览：' + first + ' · A1:L30；Excel 日期系统：' + preview['dateSystem']]
        for row in preview['rows']:
            cells = []
            for cell in row['cells']:
                if cell['type'] == 'blank' and cell['formula'] is None:
                    continue
                value = json.dumps(cell['value'], ensure_ascii=False)
                if cell.get('dateFormat'):
                    value = 'Excel 日期序列 ' + value + '（日期系统 ' + preview['dateSystem'] + '；格式 ' + str(cell.get('numberFormat') or cell['numberFormatId']) + '）'
                if cell['formula'] is not None:
                    value = '公式 ' + (cell['formula'] or '（共享/数组公式原文未展开）') + '；' + ('缓存=' + value if cell['cached'] else '没有缓存结果')
                cells.append(cell['address'] + '=' + value)
            if cells:
                lines.append(' | '.join(cells))
        text = '\n'.join(lines)
        page_limit_reached = True
        warnings.extend(preview.get('warnings', []))
        warnings.append('Excel 仅预览首张工作表 A1:L30；完整目录与指定范围请用表格工具读取。未执行宏或公式重算，公式缓存可能过时。')
    elif ext == '.xls':
        raise ValueError('旧版 .xls 暂不支持，请先另存为 .xlsx。')
    elif ext in ('.docx','.pptx'):
        with zipfile.ZipFile(path) as z:
            if ext == '.docx': names = ['word/document.xml']
            else:
                import re
                names = sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)), key=lambda n:int(re.search(r'slide(\d+)',n).group(1)))
                if len(names) > 100:
                    page_limit_reached = True
                    warnings.append(f'演示文稿共 {len(names)} 页，仅提取前 100 页。')
                names = names[:100]
            # Only expand the XML actually used for text, never embedded media.
            # Keep a decompression budget independent of the uploaded file size.
            infos = [z.getinfo(name) for name in names]
            if sum(info.file_size for info in infos) > MAX_XML_BYTES:
                raise ValueError('待提取的 XML 文字内容解压后超过 60 MB。')
            parts = []
            expanded = 0
            for i, info in enumerate(infos):
                with z.open(info) as entry:
                    xml = entry.read(MAX_XML_BYTES - expanded + 1)
                expanded += len(xml)
                if expanded > MAX_XML_BYTES:
                    raise ValueError('待提取的 XML 文字内容解压后超过 60 MB。')
                root = ET.fromstring(xml)
                texts = [e.text for e in root.iter() if e.tag.endswith('}t') and e.text]
                parts.append((f'\n[第 {i+1} 页幻灯片]\n' if ext == '.pptx' else '') + ' '.join(texts))
                if sum(map(len, parts)) > limit: break
            text = '\n'.join(parts)
    else:
        raise ValueError('此文件类型暂不支持文本提取；原件已保留。')
    if len(text) > limit: warnings.append('提取文字超过 100000 字符，已截断。')
    print(json.dumps({'text':text[:limit], 'truncated':len(text)>limit or page_limit_reached, 'warning':' '.join(warnings) or None},ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'text':'','truncated':False,'warning':str(exc)[:500]},ensure_ascii=False))
