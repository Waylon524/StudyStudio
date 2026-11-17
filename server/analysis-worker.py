import json
import math
import os
import resource
import sys
sys.dont_write_bytecode=True
from analysis_math import calculate,analyze
from analysis_spreadsheet import read_spreadsheet,analyze_spreadsheet,MAX_FILE

try:
    resource.setrlimit(resource.RLIMIT_CPU,(8,9))
    try:
        resource.setrlimit(resource.RLIMIT_DATA,(512*1024*1024,512*1024*1024))
    except (ValueError,OSError):
        pass  # XML/input/output budgets remain enforced on platforms lacking this limit.
    payload=json.load(sys.stdin)
    if not isinstance(payload,dict):raise ValueError('请求参数无效。')
    operation,args=payload.get('operation'),payload.get('args')
    if operation=='calculate':result=calculate(args)
    elif operation=='analyze':result=analyze(args)
    elif operation in ('spreadsheet','analyze_spreadsheet'):
        if payload.get('fileFd')!=3:raise ValueError('缺少已验证的表格文件。')
        stat=os.fstat(3)
        if stat.st_size>MAX_FILE:raise ValueError('表格超过100MB。')
        with os.fdopen(os.dup(3),'rb') as file:
            result=(read_spreadsheet if operation=='spreadsheet' else analyze_spreadsheet)(file,payload.get('extension'),args)
    else:raise ValueError('不支持此计算操作。')
    print(json.dumps({'ok':True,'result':result},ensure_ascii=False,allow_nan=False))
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error)[:500]},ensure_ascii=False))
