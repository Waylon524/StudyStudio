"""Bounded, read-only OOXML workbook reader. Never opens external links/macros."""
import io
import json
import math
import os
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from analysis_math import analyze

MAX_FILE = 100 * 1024 * 1024
MAX_XML = 60 * 1024 * 1024
MAX_SHEETS = 256
MAX_CELL_TEXT = 2000
MAX_SHARED_INDEX = 1000000
SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
DATE_FORMAT_IDS = set(range(14, 23)) | {45, 46, 47}


def local(tag):
    return tag.rsplit('}', 1)[-1]


class XmlBudget:
    def __init__(self): self.remaining = MAX_XML


class CheckedXml:
    def __init__(self, source, budget):
        self.source, self.budget, self.tail = source, budget, b''
    def read(self, size=-1):
        limit = self.budget.remaining
        if limit < 0: raise ValueError('表格 XML 解压内容超过 60 MB。')
        chunk = self.source.read(min(size if size >= 0 else limit + 1, limit + 1))
        self.budget.remaining -= len(chunk)
        if self.budget.remaining < 0: raise ValueError('表格 XML 解压内容超过 60 MB。')
        probe = (self.tail + chunk).upper()
        if b'<!DOCTYPE' in probe or b'<!ENTITY' in probe or b'\0' in chunk:
            raise ValueError('表格含不支持的 XML 声明或编码。')
        self.tail = probe[-12:]
        return chunk


class Workbook:
    def __init__(self, file, extension):
        if extension not in ('xlsx', 'xlsm'):
            raise ValueError('仅支持 .xlsx/.xlsm；旧版 .xls 请先另存为 .xlsx。')
        self.archive = zipfile.ZipFile(file)
        infos = self.archive.infolist()
        if len(infos) > 10000: raise ValueError('表格 ZIP 条目过多。')
        names = [info.filename for info in infos]
        if len(names) != len(set(names)): raise ValueError('表格包含重复的 ZIP 条目。')
        self.budget, self.warnings = XmlBudget(), []
        workbook = self.xml('xl/workbook.xml')
        self.date_system = '1904' if any(local(e.tag) == 'workbookPr' and e.attrib.get('date1904') in ('1', 'true') for e in workbook.iter()) else '1900'
        relationships = self.xml('xl/_rels/workbook.xml.rels')
        targets = {}
        for rel in relationships:
            if rel.attrib.get('TargetMode') == 'External': continue
            target = rel.attrib.get('Target', '')
            if '\\' in target or '\0' in target: raise ValueError('表格内部路径无效。')
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if not name.startswith('xl/') or '/..' in name: raise ValueError('表格内部路径越界。')
            targets[rel.attrib.get('Id')] = name
        self.sheets = []
        for sheet in workbook.iter():
            if local(sheet.tag) != 'sheet': continue
            relation_id = sheet.attrib.get('{'+REL_NS+'}id')
            # Handle strict OOXML namespace as well, without trusting arbitrary targets.
            if not relation_id: relation_id = next((value for key, value in sheet.attrib.items() if key.endswith('}id')), None)
            target = targets.get(relation_id)
            if not target: raise ValueError('工作表关系不可用或指向外部资源。')
            self.sheets.append({'name': sheet.attrib.get('name', ''), 'state': sheet.attrib.get('state', 'visible'), 'target': target})
        if not self.sheets or len(self.sheets) > MAX_SHEETS: raise ValueError('工作表数量不在支持范围内。')
        self.formats = None

    def close(self): self.archive.close()
    def stream(self, name):
        info = self.archive.getinfo(name)
        if info.flag_bits & 1: raise ValueError('加密表格无法读取。')
        if info.file_size > MAX_XML: raise ValueError('单个表格 XML 解压后超过 60 MB。')
        return self.archive.open(info)
    def xml(self, name):
        with self.stream(name) as entry:
            return ET.parse(CheckedXml(entry, self.budget)).getroot()
    def style_formats(self):
        if self.formats is not None: return self.formats
        self.formats = []
        if 'xl/styles.xml' in self.archive.namelist():
            root = self.xml('xl/styles.xml')
            custom = {int(e.attrib['numFmtId']): e.attrib.get('formatCode','') for e in root.iter() if local(e.tag)=='numFmt'}
            for parent in root:
                if local(parent.tag) == 'cellXfs':
                    for entry in parent:
                        number_id=int(entry.attrib.get('numFmtId','0')); code=custom.get(number_id)
                        unquoted=re.sub(r'"[^"]*"|\\.|\[[^]]*\]', '', code or '')
                        is_date=number_id in DATE_FORMAT_IDS or bool(re.search(r'[ymdhs]',unquoted,re.IGNORECASE)) or bool(re.search(r'\[(?:h+|m+|s+)\]',code or '',re.IGNORECASE))
                        self.formats.append({'id':number_id,'code':code,'date':is_date})
        return self.formats
    def shared_strings(self, needed):
        if not needed: return {}
        if min(needed) < 0 or max(needed) > MAX_SHARED_INDEX: raise ValueError('共享字符串索引超出支持范围。')
        found, index = {}, 0
        with self.stream('xl/sharedStrings.xml') as entry:
            for event, element in ET.iterparse(CheckedXml(entry, self.budget), events=('end',)):
                if local(element.tag) != 'si': continue
                if index in needed:
                    found[index] = ''.join(e.text or '' for e in element.iter() if local(e.tag) == 't')
                    if len(found) == len(needed): break
                index += 1; element.clear()
                if index > MAX_SHARED_INDEX: raise ValueError('共享字符串数量超出支持范围。')
        if len(found) != len(needed): raise ValueError('表格共享字符串引用不完整。')
        return found


def column_index(value):
    total = 0
    for char in value.upper(): total = total * 26 + ord(char) - 64
    if not 1 <= total <= 16384: raise ValueError('列超出 Excel 范围。')
    return total


def column_name(index):
    result = ''
    while index:
        index, rest = divmod(index - 1, 26); result = chr(rest + 65) + result
    return result


def cell_position(value):
    match = re.fullmatch(r'\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})', value or '')
    if not match: raise ValueError('单元格地址须使用 A1 格式。')
    column, row = column_index(match[1]), int(match[2])
    if row > 1048576: raise ValueError('行超出 Excel 范围。')
    return row, column


def parse_range(value):
    if not isinstance(value, str) or len(value) > 40: raise ValueError('请提供如 A1:D50 的有限单元格范围。')
    pieces = value.split(':')
    if len(pieces) not in (1, 2): raise ValueError('表格范围无效。')
    start = cell_position(pieces[0]); end = cell_position(pieces[-1])
    if end[0] < start[0] or end[1] < start[1]: raise ValueError('表格范围顺序无效。')
    return start[0], start[1], end[0], end[1]


def positive_int(value, maximum, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(label+'超出支持范围。')
    return value


def _number(value):
    try: result = float(value)
    except (TypeError, ValueError): raise ValueError('表格数字内容无效。')
    if not math.isfinite(result): raise ValueError('表格含非有限数字。')
    return int(result) if result.is_integer() and abs(result) < 2**53 else result


def _read_cells(book, sheet, bounds, text_limit=MAX_CELL_TEXT):
    start_row, start_col, end_row, end_col = bounds
    raw, shared, formula_ranges = {}, set(), []
    formats = book.style_formats()
    with book.stream(sheet['target']) as entry:
        for event, element in ET.iterparse(CheckedXml(entry, book.budget), events=('end',)):
            if local(element.tag) != 'row': continue
            row_number = int(element.attrib.get('r', '0'))
            if row_number > end_row: break
            for cell in element:
                if local(cell.tag) != 'c': continue
                row, col = cell_position(cell.attrib.get('r'))
                if row != row_number: raise ValueError('工作表行与单元格地址不一致。')
                formula = next((child for child in cell if local(child.tag) == 'f'), None)
                if formula is not None and formula.attrib.get('ref'):
                    covered=parse_range(formula.attrib['ref'])
                    if covered[0]<=end_row and covered[2]>=start_row and covered[1]<=end_col and covered[3]>=start_col:
                        formula_ranges.append({'bounds':covered,'origin':column_name(col)+str(row),'range':formula.attrib['ref'],'kind':formula.attrib.get('t','array')})
                        if len(formula_ranges)>2000: raise ValueError('范围涉及的数组或共享公式过多，请缩小读取范围。')
                if row_number >= start_row and start_col <= col <= end_col:
                    address = column_name(col)+str(row)
                    if address in raw: raise ValueError('工作表包含重复单元格。')
                    value_node = next((child for child in cell if local(child.tag) == 'v'), None)
                    value = value_node.text if value_node is not None else None
                    kind = cell.attrib.get('t', 'n')
                    if kind == 's' and value is not None:
                        value = int(value); shared.add(value)
                    elif kind == 'inlineStr':
                        value = ''.join(child.text or '' for child in cell.iter() if local(child.tag) == 't'); kind = 'str'
                    elif kind == 'b':
                        if value not in ('0', '1', None): raise ValueError('表格布尔内容无效。')
                        value = value == '1' if value is not None else None
                    elif kind == 'n' and value is not None: value = _number(value)
                    elif kind not in ('str', 'e', 'd', 'n', 's'): raise ValueError('不支持此单元格类型。')
                    style = int(cell.attrib.get('s', '-1'))
                    format_info = formats[style] if 0 <= style < len(formats) else {'id':0,'code':None,'date':False}
                    format_id = format_info['id']
                    raw[address] = {'address': address, 'type': {'s':'string','str':'string','n':'number','b':'boolean','e':'error','d':'date'}.get(kind,kind) if value is not None else 'blank', 'value': value, 'formula': formula.text or '' if formula is not None else None, 'cached': formula is not None and value_node is not None and value_node.text is not None, '_has_value': value_node is not None and value_node.text is not None or kind=='str' and value is not None, 'numberFormatId': format_id, 'numberFormat': format_info['code'], 'dateFormat': format_info['date'], 'formulaKind': formula.attrib.get('t','normal') if formula is not None else None, 'formulaTextAvailable': bool(formula.text) if formula is not None else False, '_shared': kind == 's' and value is not None}
            element.clear()
    strings = book.shared_strings(shared)
    text_budget = 200000
    for cell in raw.values():
        if cell.pop('_shared'): cell['value'] = strings[cell['value']]
        if isinstance(cell['value'], str):
            original = cell['value']; cap = min(text_limit, text_budget)
            cell['value'] = original[:cap]; text_budget -= len(cell['value'])
            if len(original) > cap: cell['truncated'] = True
    return raw,formula_ranges


def read_spreadsheet(file, extension, args, analysis=False):
    if not isinstance(args, dict) or set(args) - {'sheet','range','rowLimit','columnLimit'}:
        raise ValueError('表格读取参数无效。')
    book = Workbook(file, extension)
    try:
        sheet_name = args.get('sheet')
        listed = [{'name': sheet['name'], 'state': sheet['state']} for sheet in book.sheets]
        if sheet_name is None:
            if any(key in args for key in ('range','rowLimit','columnLimit')): raise ValueError('读取范围前请先指定工作表名称。')
            return {'kind':'spreadsheet','sheets':listed,'dateSystem':book.date_system,'formulasCalculated':False,'warnings':['只读工作表目录；未执行宏、外部链接或公式重算。']}
        if not isinstance(sheet_name, str): raise ValueError('sheet 必须是工作表名称。')
        sheet = next((item for item in book.sheets if item['name'] == sheet_name), None)
        if not sheet: raise ValueError('找不到指定工作表。')
        max_rows, max_cols, max_cells = (10000,2,20000) if analysis else (200,50,5000)
        rows = positive_int(args.get('rowLimit', min(max_rows, 50)),max_rows,'rowLimit')
        cols = positive_int(args.get('columnLimit', min(max_cols, 20)),max_cols,'columnLimit')
        requested = args.get('range', f'A1:{column_name(cols)}{rows}')
        r1,c1,r2,c2 = parse_range(requested)
        if c2-c1+1 > cols: raise ValueError('范围列数超过 columnLimit，请缩小列范围。')
        returned_end = min(r2, r1 + rows - 1)
        if (returned_end-r1+1)*(c2-c1+1) > max_cells: raise ValueError('一次读取的单元格过多，请缩小范围。')
        raw,formula_ranges = _read_cells(book,sheet,(r1,c1,returned_end,c2))
        result_rows = []
        for row in range(r1,returned_end+1):
            cells=[]
            for col in range(c1,c2+1):
                address=column_name(col)+str(row)
                cell=raw.get(address,{'address':address,'type':'blank','value':None,'formula':None,'cached':False,'numberFormatId':0,'numberFormat':None,'dateFormat':False,'formulaKind':None,'formulaTextAvailable':False})
                covering=[entry for entry in formula_ranges if entry['bounds'][0]<=row<=entry['bounds'][2] and entry['bounds'][1]<=col<=entry['bounds'][3]]
                if covering:
                    if len(covering)>1: raise ValueError('数组或共享公式范围发生重叠，无法可靠判断缓存来源。')
                    entry=covering[0];cell['formulaOrigin']=entry['origin'];cell['formulaRange']=entry['range']
                    if cell['formula'] is None:
                        cell['formula']='';cell['formulaKind']=entry['kind']+'_cached_follower';cell['cached']=bool(cell.get('_has_value'))
                cell.pop('_has_value',None)
                cells.append(cell)
            result_rows.append({'row':row,'cells':cells})
        warnings=['公式未重算；formula 是公式原文，cached 表示是否包含文件中既有缓存结果，缓存可能过时。']
        if any(cell.get('truncated') for row in result_rows for cell in row['cells']): warnings.append('部分单元格文字已截断。')
        if any(cell['formula'] is not None and not cell['formulaTextAvailable'] for row in result_rows for cell in row['cells']): warnings.append('部分共享或数组公式原文未展开；有缓存时仍仅返回既有缓存值。')
        if any(cell['dateFormat'] for row in result_rows for cell in row['cells']): warnings.append('含 Excel 日期格式数字，按原始序列值返回；未自动解释为日期。')
        return {'kind':'spreadsheet','sheet':sheet_name,'sheets':listed,'dateSystem':book.date_system,'requestedRange':requested,'returnedRange':f'{column_name(c1)}{r1}:{column_name(c2)}{returned_end}','rows':result_rows,'truncated':returned_end<r2,'nextRange':f'{column_name(c1)}{returned_end+1}:{column_name(c2)}{r2}' if returned_end<r2 else None,'formulasCalculated':False,'warnings':warnings}
    finally: book.close()


def analyze_spreadsheet(file,extension,args):
    if not isinstance(args,dict): raise ValueError('统计参数必须是对象。')
    options=dict(args)
    sheet, selected_range = options.pop('sheet',None),options.pop('range',None)
    if not sheet or not selected_range: raise ValueError('直接统计表格时必须指定 sheet 与 range，并排除表头。')
    r1,c1,r2,c2=parse_range(selected_range)
    if r2-r1+1>10000 or c2-c1+1>2: raise ValueError('表格直接统计最多10000行、2列。')
    result=read_spreadsheet(file,extension,{'sheet':sheet,'range':selected_range,'rowLimit':10000,'columnLimit':2},analysis=True)
    columns=[[],[]]
    formula_count=0
    for row in result['rows']:
        for index,cell in enumerate(row['cells']):
            if cell['formula'] is not None:
                if not cell['cached']: raise ValueError('统计范围含没有缓存结果的公式；请先在表格软件中计算并保存。')
                formula_count+=1
            if cell['type'] not in ('number','blank') or cell['dateFormat']:
                raise ValueError('统计范围含文本、表头、布尔值、错误或日期；请选择纯数字范围。')
            columns[index].append(cell['value'])
    operation=options.get('operation')
    needed=2 if operation in ('correlation','linear_regression') or operation=='t_test' and options.get('design','welch') in ('welch','paired') else 1
    if c2-c1+1!=needed: raise ValueError('本次统计需要'+str(needed)+'列数字。')
    if any(key in options for key in ('values','x','y')): raise ValueError('指定表格来源时不能同时提交重复的数据数组。')
    if needed==1 and operation=='describe':options['values']=columns[0]
    else:
        options['x']=columns[0]
        if needed==2:options['y']=columns[1]
    analysis_result=analyze(options)
    analysis_result['source']={'sheet':sheet,'range':selected_range,'formulaCachedCells':formula_count,'formulasRecalculated':False}
    if formula_count:analysis_result.setdefault('notes',[]).append('包含公式的既有缓存值，未重新计算，缓存可能过时。')
    return analysis_result
