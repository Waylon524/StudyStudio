const numericSeries={type:'array',items:{type:['number','null']},maxItems:10000};
const source={type:'object',properties:{path:{type:'string'},sheet:{type:'string'},range:{type:'string'}},required:['path','sheet','range'],additionalProperties:false};
export const analysisTools=[
 {type:'function',name:'study_calculate',description:'使用本机计算器准确计算数值表达式，支持 + - * / // % **、pi/e/tau，以及 sqrt/log/log10/log2/exp、sin/cos/tan/asin/acos/atan（弧度）、radians/degrees、abs/round/floor/ceil；只接受数学表达式，不运行程序。需要精确数值时调用，并向用户说明公式和单位。',inputSchema:{type:'object',properties:{expression:{type:'string',maxLength:2000}},required:['expression'],additionalProperties:false}},
 {type:'function',name:'study_analyze',description:'在本机执行描述统计、t 检验、Pearson 相关或带截距的一元线性回归。提供数值数组，或用 source 直接指定课程 Excel 的工作表和纯数值单元格范围（排除表头，最多10000行、2列），无需把整表复制到对话。报告样本量、缺失值处理、假设和适用条件，不把相关当因果。',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['describe','t_test','correlation','linear_regression']},values:numericSeries,x:numericSeries,y:numericSeries,design:{type:'string',enum:['one_sample','welch','paired']},mu:{type:'number'},alternative:{type:'string',enum:['two-sided','less','greater']},missing:{type:'string',enum:['reject','omit']},source},required:['operation'],additionalProperties:false}},
 {type:'function',name:'study_spreadsheet',description:'只读查看课程内的 .xlsx/.xlsm Excel。省略 sheet 列出工作表；指定 sheet 和 range（如 A1:F50）读取单元格，可按 nextRange 继续。每次最多200行、50列、5000格。返回公式及文件保存的缓存值，不计算 Excel 公式，不运行宏；缓存可能过期，缺失时明确说明。旧 .xls 需用户另存为 .xlsx。',inputSchema:{type:'object',properties:{path:{type:'string'},sheet:{type:'string'},range:{type:'string'},rowLimit:{type:'integer',minimum:1,maximum:200},columnLimit:{type:'integer',minimum:1,maximum:50}},required:['path'],additionalProperties:false}},
];

// Existing Codex rollouts retain their registered tool list. The stable render
// entry can carry a typed local-analysis request without saving a UI component.
export function parseAnalysisRequest(spec){
 if(!spec||typeof spec!=='object'||Array.isArray(spec)||!['calculate','analyze','spreadsheet'].includes(spec.operation))return null;
 if(!spec.arguments||typeof spec.arguments!=='object'||Array.isArray(spec.arguments)||Object.keys(spec).some(key=>!['operation','arguments'].includes(key)))throw Error('不支持的计算请求。');
 return {tool:'study_'+spec.operation,arguments:spec.arguments};
}
