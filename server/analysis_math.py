"""Bounded real-number arithmetic/statistics. No evaluation of Python code."""
import ast
import math
import statistics

MAX_VALUES = 10000
FUNCTIONS = {
    'sqrt': math.sqrt, 'log': math.log, 'log10': math.log10, 'log2': math.log2,
    'exp': math.exp, 'sin': math.sin, 'cos': math.cos, 'tan': math.tan,
    'asin': math.asin, 'acos': math.acos, 'atan': math.atan,
    'abs': abs, 'round': round, 'floor': math.floor, 'ceil': math.ceil,
    'radians': math.radians, 'degrees': math.degrees,
}
CONSTANTS = {'pi': math.pi, 'e': math.e, 'tau': math.tau}


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError('数据必须是有限数字；不要把文本、布尔值或表头当成数字。')
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('数据或计算结果不是有限数字。')
    return value


def calculate(args):
    if not isinstance(args, dict) or set(args) != {'expression'}:
        raise ValueError('计算需要 expression，且不接受其他操作。')
    expression = args['expression']
    if not isinstance(expression, str) or not expression.strip() or len(expression) > 2000:
        raise ValueError('表达式须为 1–2000 字符。')
    tree = ast.parse(expression, mode='eval')
    if sum(1 for _ in ast.walk(tree)) > 256:
        raise ValueError('表达式过于复杂，请分步计算。')

    def evaluate(node, depth=0):
        if depth > 32:
            raise ValueError('表达式嵌套过深。')
        if isinstance(node, ast.Expression):
            return evaluate(node.body, depth + 1)
        if isinstance(node, ast.Constant):
            return finite(node.value)
        if isinstance(node, ast.Name) and node.id in CONSTANTS:
            return CONSTANTS[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand, depth + 1)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = evaluate(node.left, depth + 1), evaluate(node.right, depth + 1)
            if isinstance(node.op, ast.Add): value = left + right
            elif isinstance(node.op, ast.Sub): value = left - right
            elif isinstance(node.op, ast.Mult): value = left * right
            elif isinstance(node.op, ast.Div): value = left / right
            elif isinstance(node.op, ast.FloorDiv): value = left // right
            elif isinstance(node.op, ast.Mod): value = left % right
            elif isinstance(node.op, ast.Pow):
                if abs(right) > 1000:
                    raise ValueError('指数绝对值不能超过 1000。')
                value = left ** right
            else:
                raise ValueError('不支持此运算；幂使用 **，不使用 ^。')
            return finite(value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS:
            if node.keywords or not 1 <= len(node.args) <= 2:
                raise ValueError('函数只接受 1–2 个位置数字参数。')
            values = [evaluate(arg, depth + 1) for arg in node.args]
            if node.func.id == 'round' and len(values) == 2:
                if values[1] != int(values[1]) or abs(values[1]) > 100:
                    raise ValueError('round 的位数必须是 -100..100 的整数。')
                values[1] = int(values[1])
            return finite(FUNCTIONS[node.func.id](*values))
        raise ValueError('只支持数字、基本运算、白名单数学函数及 pi/e/tau；不执行代码。')
    return {'expression': expression, 'value': finite(evaluate(tree)), 'angleUnit': 'radians', 'method': 'bounded_real_arithmetic'}


def vector(value, missing='reject'):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_VALUES:
        raise ValueError('每列需要 1–10000 个数据。')
    if missing not in ('reject', 'omit'):
        raise ValueError('missing 只能为 reject 或 omit。')
    result, omitted = [], 0
    for item in value:
        if item is None:
            if missing == 'reject': raise ValueError('数据含空值；可明确设置 missing=omit。')
            omitted += 1
        else:
            number = finite(item)
            if abs(number) > 1e150: raise ValueError('统计数据绝对值不能超过 1e150。')
            result.append(number)
    if not result: raise ValueError('没有可用于计算的数字。')
    return result, omitted


def pairs(x, y, missing):
    if not isinstance(x, list) or not isinstance(y, list) or len(x) != len(y) or not 1 <= len(x) <= MAX_VALUES:
        raise ValueError('成对数据 x/y 必须等长且为 1–10000 行。')
    if missing not in ('reject', 'omit'): raise ValueError('missing 只能为 reject 或 omit。')
    kept_x, kept_y, omitted = [], [], 0
    for a, b in zip(x, y):
        # Non-numeric entries are always errors, including rows with a missing partner.
        if a is not None: finite(a)
        if b is not None: finite(b)
        if a is None or b is None:
            if missing == 'reject': raise ValueError('成对数据含空值；可明确设置 missing=omit 按行剔除。')
            omitted += 1
            continue
        a, b = finite(a), finite(b)
        if max(abs(a), abs(b)) > 1e150: raise ValueError('统计数据绝对值不能超过 1e150。')
        kept_x.append(a); kept_y.append(b)
    if not kept_x: raise ValueError('没有完整的成对数字。')
    return kept_x, kept_y, omitted


def _beta_fraction(a, b, x):
    """Lentz continued fraction for the regularized incomplete beta."""
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    tiny = 1e-300
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < tiny: d = tiny
    d = 1.0 / d
    result = d
    for m in range(1, 501):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d; c = 1.0 + aa / c
        if abs(d) < tiny: d = tiny
        if abs(c) < tiny: c = tiny
        d = 1.0 / d; result *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d; c = 1.0 + aa / c
        if abs(d) < tiny: d = tiny
        if abs(c) < tiny: c = tiny
        d = 1.0 / d; delta = d * c; result *= delta
        if abs(delta - 1.0) < 3e-14: return result
    raise ValueError('统计分布数值积分未收敛，请检查极端输入。')


def _regularized_beta(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    factor = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1.0) / (a + b + 2.0):
        return factor * _beta_fraction(a, b, x) / a
    return 1.0 - factor * _beta_fraction(b, a, 1.0 - x) / b


def t_probability(t, df, alternative='two-sided'):
    if alternative not in ('two-sided', 'greater', 'less'):
        raise ValueError('alternative 只能为 two-sided、greater 或 less。')
    if df <= 0 or not math.isfinite(df): raise ValueError('自由度不可用。')
    if t == 0: smaller = 0.5
    elif t * t < df:
        # Complement avoids losing tiny t values when df/(df+t²) rounds to one.
        smaller = 0.5 * (1.0 - _regularized_beta(0.5, df / 2.0, t * t / (df + t * t)))
    else: smaller = 0.5 * _regularized_beta(df / 2.0, 0.5, df / (df + t * t))
    less = smaller if t < 0 else 1.0 - smaller
    greater = smaller if t > 0 else 1.0 - smaller
    return min(1.0, max(0.0, 2 * smaller if alternative == 'two-sided' else less if alternative == 'less' else greater))


def analyze(args):
    if not isinstance(args, dict): raise ValueError('统计参数必须是对象。')
    allowed = {'operation', 'values', 'x', 'y', 'design', 'mu', 'alternative', 'missing'}
    if set(args) - allowed: raise ValueError('统计参数包含不支持的字段。')
    operation, missing = args.get('operation'), args.get('missing', 'reject')
    notes = []
    if operation == 'describe':
        values, omitted = vector(args.get('values'), missing)
        n = len(values); sd = statistics.stdev(values) if n > 1 else None
        quartiles = statistics.quantiles(values, n=4, method='inclusive') if n > 1 else [values[0]] * 3
        return {'operation': operation, 'n': n, 'omitted': omitted, 'mean': statistics.fmean(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values), 'sum': math.fsum(values), 'sampleVariance': statistics.variance(values) if n > 1 else None, 'sampleStdDev': sd, 'standardError': sd / math.sqrt(n) if n > 1 else None, 'q1': quartiles[0], 'q3': quartiles[2], 'quantileMethod': 'linear_inclusive', 'notes': ['标准差和方差使用 n-1 分母；单个样本时不可估计。']}
    if operation == 't_test':
        design, mu = args.get('design', 'welch'), finite(args.get('mu', 0))
        alternative = args.get('alternative', 'two-sided')
        if design == 'paired':
            x, y, omitted = pairs(args.get('x'), args.get('y'), missing)
            values = [a - b for a, b in zip(x, y)]; n = len(values)
            if n < 2: raise ValueError('配对 t 检验至少需要两对完整数据。')
            mean, variance = statistics.fmean(values), statistics.variance(values)
            se, df = math.sqrt(variance / n), n - 1
            detail = {'n': n, 'omittedPairs': omitted, 'meanDifference': mean}
        elif design == 'one_sample':
            values, omitted = vector(args.get('x', args.get('values')), missing); n = len(values)
            if n < 2: raise ValueError('单样本 t 检验至少需要两个数字。')
            mean, variance = statistics.fmean(values), statistics.variance(values)
            se, df = math.sqrt(variance / n), n - 1
            detail = {'n': n, 'omitted': omitted, 'mean': mean}
        elif design == 'welch':
            x, omitted_x = vector(args.get('x'), missing); y, omitted_y = vector(args.get('y'), missing)
            if len(x) < 2 or len(y) < 2: raise ValueError('Welch t 检验每组至少需要两个数字。')
            nx, ny = len(x), len(y); vx, vy = statistics.variance(x), statistics.variance(y)
            ax, ay = vx / nx, vy / ny
            se = math.sqrt(ax + ay)
            # Scaling prevents the fourth-power terms from overflowing.
            scale = max(ax, ay)
            df = ((ax / scale + ay / scale) ** 2 / ((ax / scale) ** 2 / (nx - 1) + (ay / scale) ** 2 / (ny - 1))) if scale else 0
            mean = statistics.fmean(x) - statistics.fmean(y)
            detail = {'nX': nx, 'nY': ny, 'omittedX': omitted_x, 'omittedY': omitted_y, 'meanX': statistics.fmean(x), 'meanY': statistics.fmean(y), 'meanDifference': mean}
        else: raise ValueError('design 只能为 one_sample、welch 或 paired。')
        if not se: raise ValueError('样本没有可估计的变异，不能进行 t 检验。')
        if design=='welch':
            origin_x,origin_y=x[0],y[0]
            offset_x=statistics.fmean(value-origin_x for value in x)
            offset_y=statistics.fmean(value-origin_y for value in y)
            mean=math.fsum([origin_x,-origin_y,offset_x,-offset_y])
            detail['meanDifference']=mean
            numerator=math.fsum([origin_x,-origin_y,offset_x,-offset_y,-mu])
            rounded_difference=math.fsum([detail['meanX'],-detail['meanY'],-mu])
        else:
            origin=values[0];offset=statistics.fmean(value-origin for value in values)
            numerator=math.fsum([origin,-mu,offset])
            rounded_difference=mean-mu
        t=numerator/se
        if rounded_difference!=numerator:notes.append('大基准值下展示均值可能舍入；检验使用原点平移后的差值。')
        return {'operation': operation, 'design': design, **detail, 'nullDifference': mu, 'meanMinusNull':numerator, 'standardError': se, 'statistic': t, 'degreesOfFreedom': df, 'alternative': alternative, 'pValue': t_probability(t, df, alternative), 'notes': ['检验依赖抽样独立性及相应分布条件；配对检验要求同一对象成对。p 值不是原假设为真的概率，也不证明因果。']+notes}
    if operation in ('correlation', 'linear_regression'):
        x, y, omitted = pairs(args.get('x'), args.get('y'), missing); n = len(x)
        if n < 3: raise ValueError('相关分析或回归推断至少需要三对完整数据。')
        origin_x, origin_y = x[0], y[0]
        shifted_x, shifted_y = [v-origin_x for v in x], [v-origin_y for v in y]
        offset_x, offset_y = statistics.fmean(shifted_x), statistics.fmean(shifted_y)
        mx, my = origin_x+offset_x, origin_y+offset_y
        xx, yy = [v-offset_x for v in shifted_x], [v-offset_y for v in shifted_y]
        sxx, syy, sxy = math.fsum(v * v for v in xx), math.fsum(v * v for v in yy), math.fsum(a * b for a, b in zip(xx, yy))
        if not sxx: raise ValueError('x 没有变异，相关或回归斜率不可估计。')
        r = max(-1.0, min(1.0, sxy / math.sqrt(sxx) / math.sqrt(syy))) if syy else None
        p = t_probability(r * math.sqrt((n - 2) / max(1e-300, 1 - r * r)), n - 2) if r is not None and abs(r) < 1 else (0.0 if r is not None else None)
        if operation == 'correlation':
            if r is None: raise ValueError('y 没有变异，相关系数不可估计。')
            return {'operation': operation, 'method': 'Pearson', 'n': n, 'omittedPairs': omitted, 'r': r, 'degreesOfFreedom': n - 2, 'pValue': p, 'notes': ['p 值检验零线性相关；依赖独立抽样和相关分布假设，相关不代表因果。']}
        slope = sxy / sxx
        intercept = math.fsum([origin_y,-slope*origin_x,offset_y,-slope*offset_x])
        residual = math.fsum((b-slope*a)**2 for a,b in zip(xx,yy))
        residual_variance = residual / (n - 2)
        return {'operation': operation, 'method': 'OLS_with_intercept', 'n': n, 'omittedPairs': omitted, 'slope': slope, 'intercept': intercept, 'rSquared': max(0.0,1.0-residual/syy) if syy else None, 'slopeStdError': math.sqrt(residual_variance / sxx), 'interceptStdError': math.sqrt(residual_variance * (1.0 / n + mx * mx / sxx)), 'residualStdError': math.sqrt(residual_variance), 'degreesOfFreedom': n - 2, 'slopePValue': p, 'notes': ['回归含截距；斜率检验依赖独立、同方差及残差分布条件。未检验这些假设，不代表因果。'] + (['y 没有变异，R²及斜率 p 值不可估计。'] if syy == 0 else [])}
    raise ValueError('operation 只支持 describe、t_test、correlation、linear_regression。')
