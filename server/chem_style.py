"""One compact textbook compositor for structural and formula-based reactions."""
import math
import re
from collections import deque
from copy import deepcopy
from xml.etree import ElementTree as ET

import cairocffi as cairo
from codex_organic_chem import figure_style, mechanism_scene, route_figure
from chem_arrows import graphics
from chem_reagents import reagent_parts
from codex_organic_chem.figure_audit import FigureElement
from rdkit import Chem
from rdkit.Chem import rdDepictor

FONT = 13.0
SCRIPT = 8.0
BOND = 24.0
LINE = 0.8
TNR = '/System/Library/Fonts/Supplemental/Times New Roman.ttf'
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
SUB = dict(zip('₀₁₂₃₄₅₆₇₈₉₊₋', '0123456789+-'))
SUP = dict(zip('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻', '0123456789+-'))
_context = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1))
_modes = deque()
_arrow_geometry = []
_reagent_lanes = deque()
_reagent_elements = []


def text_runs(value):
    runs = []
    for char in str(value).replace('℃', '°C'):
        kind = 'sub' if char in SUB else 'sup' if char in SUP else 'normal'
        char = SUB.get(char, SUP.get(char, char))
        family = 'Songti SC' if ord(char) >= 0x2e80 else 'Times New Roman'
        if runs and runs[-1][:2] == [kind, family]:
            runs[-1][2] += char
        else:
            runs.append([kind, family, char])
    return runs


def metrics(value, size=FONT):
    width, top, bottom = 0, 0, 0
    for kind, family, text in text_runs(value):
        fs = size if kind == 'normal' else SCRIPT
        offset = size * .25 if kind == 'sub' else -size * .36 if kind == 'sup' else 0
        _context.select_font_face(family)
        _context.set_font_size(fs)
        _, y, _, height, advance, _ = _context.text_extents(text)
        width += advance
        top, bottom = min(top, y + offset), max(bottom, y + height + offset)
    return width, top, bottom


def condition_text(value):
    value = str(value).replace('℃', '°C')
    symbols = [ChemSymbol for ChemSymbol in ('Cl Br Na Mg Li Zn Ag Cr Mn Si Al Fe Cu Hg Ca Ba Sn Pb Ni Co Pt Pd Ti Au Se As Sb Bi Cs Rb Sr Be Xe Ne He Ar Kr Ph Me Et Bu C H N O F B S P K I').split()]
    atom = '(?:' + '|'.join(symbols) + ')'
    def sub(match):
        token = match.group()
        if token in ['SN1', 'SN2', 'E1', 'E2']:
            return token
        return re.sub(r'\d+', lambda m: m.group().translate(str.maketrans('0123456789', '₀₁₂₃₄₅₆₇₈₉')), token)
    return re.sub(r'(?<![A-Za-z0-9])(?:' + atom + r'\d*)+(?![A-Za-z])', sub, value)


def arrow(x1, y, x2, label='', sublabel=''):
    from html import escape
    kind = _modes.popleft() if _modes else 'forward'
    lane = _reagent_lanes.popleft() if _reagent_lanes else None
    g = graphics(x1, y, x2, 'equilibrium' if kind == 'equilibrium' else 'forward')
    if kind == 'reverse':
        g = f'<g transform="translate({x1+x2} 0) scale(-1 1)">{g}</g>'
    extra = 1.6 if kind == 'equilibrium' else 0
    upper, lower = y - 5 - extra, y + 5 + extra - metrics(sublabel)[1]
    top = min(y-4, upper+metrics(label)[1] if label else y)
    bottom = max(y+4, lower+metrics(sublabel)[2] if sublabel else y)
    _arrow_geometry.append((x1, top, x2, bottom))
    if lane:
        lane_bottom = upper + metrics(label)[1] - 6 if label else y - 9 - extra
        g += render_reagent_lane(lane, (x1+x2)/2, lane_bottom)
    return (g + f'<text x="{(x1+x2)/2}" y="{upper}" class="conditionLabel" text-anchor="middle">{escape(label)}</text>'
            + f'<text x="{(x1+x2)/2}" y="{lower}" class="conditionLabel" text-anchor="middle">{escape(sublabel)}</text>')


_native_render = figure_style.render_molecule
_drawer = figure_style.rdMolDraw2D.MolDraw2DSVG
_prepare_and_draw = figure_style.rdMolDraw2D.PrepareAndDrawMolecule
_prepare = route_figure._prepare_row
_compose = route_figure._compose_svg


def fixed_drawer(*args, **kwargs):
    d = _drawer(*args, **kwargs)
    d.drawOptions().fixedFontSize = int(FONT)
    d.drawOptions().fontFile = TNR
    return d


def prepare_and_draw(drawer, mol, *args, **kwargs):
    # RDKit centres on heavy atoms; an all-hydrogen graph has none. Centring
    # that graph divides by zero even after finite coordinates were generated.
    if mol.GetNumAtoms() and all(atom.GetAtomicNum() == 1 for atom in mol.GetAtoms()):
        drawer.drawOptions().centreMoleculesBeforeDrawing = False
    return _prepare_and_draw(drawer, mol, *args, **kwargs)


def compact_molecule(smiles=None, molfile=None, preset=None, **kwargs):
    settings = dict(preset) if isinstance(preset, dict) else figure_style.resolve_preset(preset)
    settings.update(cell_padding=2.5, bond_line_width=LINE, bond_length_px=BOND,
                    min_font_size=13, max_font_size=13, base_font_size=.6,
                    explicit_methyl=False, monochrome=True)
    mol = kwargs.pop('mol', None)
    if mol is None:
        mol = figure_style.prepare_mol(smiles=smiles, molfile=molfile)
    if not usable_coordinates(mol):
        # CoordGen can return NaN coordinates for hydrogen-only species without
        # raising. Recompute geometry with RDKit while retaining the exact graph,
        # atom maps, isotopes and stereochemistry used by the route/mechanism.
        mol = Chem.Mol(mol)
        rdDepictor.Compute2DCoords(mol, clearConfs=True, forceRDKit=True)
        figure_style._normalize_bond_units(mol)
        if not usable_coordinates(mol):
            raise ValueError('Unable to generate finite molecule coordinates.')
    return _native_render(mol=mol, preset=settings, **kwargs)


def usable_coordinates(mol):
    if not mol.GetNumAtoms() or not mol.GetNumConformers():
        return False
    conf = mol.GetConformer()
    points = [conf.GetAtomPosition(i) for i in range(mol.GetNumAtoms())]
    if not all(math.isfinite(v) for p in points for v in (p.x, p.y, p.z)):
        return False
    return all((points[b.GetBeginAtomIdx()] - points[b.GetEndAtomIdx()]).Length() > 1e-6
               for b in mol.GetBonds())


def prepare_reagent_lane(source, normalized, warnings, preset):
    parts = reagent_parts(source)
    if parts is None:
        raise ValueError('箭头上的 reagent_smiles 必须是有效的试剂 SMILES。')
    prepared, width, height = [], 0, 0
    for index, part in enumerate(parts):
        if index:
            prepared.append({'text': '+', 'width': 16})
            width += 16
        if 'text' in part:
            item = {'text': part['text'], 'width': metrics(part['text'])[0] + 2}
            height = max(height, metrics(part['text'])[2] - metrics(part['text'])[1])
        else:
            # Use exactly the same normalizer, painter and fixed bond geometry
            # as reactants/products; do not turn an organic reagent into a formula.
            row = _prepare({'items': [{'smiles': part['smiles']}]}, normalized, warnings, preset)
            item = row['items'][0]
            height = max(height, item['depiction'].height)
        prepared.append(item)
        width += item['width']
    return {'items': prepared, 'width': width, 'height': math.ceil(height)}


def render_reagent_lane(lane, center, bottom):
    from html import escape
    x, top = center - lane['width']/2, bottom - lane['height']
    pieces = ['<g class="reaction-reagents">']
    for item in lane['items']:
        depiction = item.get('depiction')
        if depiction:
            left = x + (item['width'] - depiction.width)/2
            y = top + (lane['height'] - depiction.height)/2
            pieces.append(f'<g class="reagent-structure" transform="translate({left:.1f},{y:.1f})">{depiction.svg_body}</g>')
            geometry = depiction.translated_geometry(left, y)
            _reagent_elements.append(FigureElement('molecule', 'reagent',
                geometry['ink_box'] or (left, y, left+depiction.width, y+depiction.height),
                bond_lengths_px=geometry['bond_lengths_px'], label_boxes=geometry['label_boxes']))
        else:
            text = item['text']
            _, glyph_top, glyph_bottom = metrics(text)
            baseline = top + (lane['height']-(glyph_bottom-glyph_top))/2 - glyph_top
            mid = x + item['width']/2
            pieces.append(f'<text x="{mid}" y="{baseline}" class="conditionLabel reagent-formula" text-anchor="middle">{escape(text)}</text>')
            w = metrics(text)[0]
            _reagent_elements.append(FigureElement('text', 'reagent:'+text,
                (mid-w/2, baseline+glyph_top, mid+w/2, baseline+glyph_bottom), collide_strictly=False))
        x += item['width']
    pieces.append('</g>')
    return ''.join(pieces)


def prepare(row, normalized, warnings, preset):
    row = deepcopy(row)
    kinds, lanes = [], []
    for item in row['items']:
        if item.get('type') == 'arrow':
            kind = item.get('arrow_kind', 'forward')
            if kind not in ['forward', 'equilibrium', 'reverse']:
                raise ValueError('Unsupported reaction arrow kind.')
            kinds.append(kind)
            lane = prepare_reagent_lane(item['reagent_smiles'], normalized, warnings, preset) if item.get('reagent_smiles') else None
            lanes.append(lane)
            item['label'] = condition_text(item.get('label', ''))
            item['sublabel'] = condition_text(item.get('sublabel') or item.get('label2') or '')
            # Arrow length always accommodates the measured condition text.
            item['width'] = max(float(item.get('width') or 0), arrow_width(item['label'], item['sublabel']), (lane['width']+16) if lane else 0)
        elif item.get('type') == 'plus':
            item['width'] = 14
        elif item.get('type') == 'text':
            item['text'] = str(item.get('text', '')).replace('℃', '°C')
            item['width'] = metrics(item['text'])[0] + (2 if item['text'].isdigit() else 6)
    prepared = _prepare(row, normalized, warnings, preset)
    for item, kind, lane in zip([i for i in prepared['items'] if i['type'] == 'arrow'], kinds, lanes):
        item['arrow_kind'] = kind
        item['reagent_lane'] = lane
    return prepared


def arrow_width(label, sublabel):
    return math.ceil(max(2.5 * BOND, max(metrics(label)[0], metrics(sublabel)[0]) + 12)) + 10


def compose(spec, rows):
    _modes.clear()
    _arrow_geometry.clear()
    _reagent_lanes.clear()
    _reagent_elements.clear()
    _reagent_lanes.extend(item.get('reagent_lane') for row in rows for item in row['items'] if item['type'] == 'arrow')
    _modes.extend(item.get('arrow_kind', 'forward') for row in rows for item in row['items'] if item['type'] == 'arrow')
    captions = [i for r in rows for i in r['items'] if i['type'] == 'molecule' and (i.get('label') or i.get('code'))]
    route_figure.LABEL_BLOCK = 34 if any(i.get('label') and i.get('code') for i in captions) else 15 if captions else 0
    # Reserve room above each arrow before laying out any ink. Increasing the
    # row's molecule cell height does not scale or alter its actual depiction.
    rows = [{**row, 'items': [dict(item) for item in row['items']]} for row in rows]
    original_minimum = route_figure.MIN_MOL_CELL
    for row in rows:
        required = 0
        for item in row['items']:
            lane = item.get('reagent_lane')
            if lane and lane['height']:
                label = item.get('label', '')
                extra = -metrics(label)[1] + 11 if label else 9
                if item.get('arrow_kind') == 'equilibrium': extra += 2
                required = max(required, math.ceil(2*(lane['height']+extra)))
        molecules = [item for item in row['items'] if item['type'] == 'molecule']
        if molecules:
            for item in molecules: item['height'] = max(item['height'], required)
        else:
            route_figure.MIN_MOL_CELL = max(route_figure.MIN_MOL_CELL, required)
    try:
        svg, elements, width, height = _compose(spec, rows)
    finally:
        route_figure.MIN_MOL_CELL = original_minimum
    elements.extend(_reagent_elements)
    svg = svg.replace('Arial, Helvetica, sans-serif', "'Times New Roman', serif")
    svg = svg.replace('font: 700 15px', 'font: 13px').replace('font: 14px', 'font: 13px').replace('font: 24px', 'font: 13px')
    svg = svg.replace('stroke-width: 1.8', 'stroke-width: 0.8')
    svg = svg.replace('</style>', ".conditionLabel { font: 13px 'Times New Roman', serif; fill:#000; }\n</style>")
    svg = re.sub(r'(<text[^>]* y=")([\d.]+)(" class="molLabel")', lambda m: m[1] + str(float(m[2]) - 12) + m[3], svg)
    svg = re.sub(r'(<text[^>]* y=")([\d.]+)(" class="plus")', lambda m: m[1] + str(float(m[2]) - 4) + m[3], svg)
    for element, box in zip([e for e in elements if e.kind == 'arrow'], _arrow_geometry):
        element.box = box
    for element in elements:
        if element.kind == 'caption':
            x0, y0, x1, y1 = element.box
            element.box = (x0, y0-12, x1, y1-12)
    root = ET.fromstring(svg)
    for node in root.iter('{' + NS + '}text'):
        if node.get('class') not in ['arrowLabel', 'plus'] or not node.text:
            continue
        x, y = float(node.get('x','0')), float(node.get('y','0'))
        w, top, bottom = metrics(node.text)
        elements.append(FigureElement('text', node.text, (x-w/2,y+top,x+w/2,y+bottom), collide_strictly=False))
    return format_text(svg), elements, width, height


def format_text(svg):
    root = ET.fromstring(svg)
    for node in root.iter('{' + NS + '}text'):
        if len(node) or not node.text:
            continue
        value, cls = node.text, node.get('class', '')
        size = 24 if cls == 'title' else FONT
        x, y = float(node.get('x', '0')), float(node.get('y', '0'))
        w = metrics(value, size)[0]
        if node.get('text-anchor') == 'middle':
            x -= w/2
        elif node.get('text-anchor') == 'end':
            x -= w
        node.set('text-anchor', 'start')
        node.text = ''
        for kind, family, text in text_runs(value):
            fs = size if kind == 'normal' else SCRIPT
            offset = size*.25 if kind == 'sub' else -size*.36 if kind == 'sup' else 0
            span = ET.SubElement(node, '{' + NS + '}tspan', {'x': str(x), 'y': str(y+offset), 'font-size': str(fs), 'font-family': family, 'font-weight': 'normal'})
            span.text = text
            _context.select_font_face(family)
            _context.set_font_size(fs)
            x += _context.text_extents(text)[4]
    return ET.tostring(root, encoding='unicode')


def mechanism_style(svg):
    """Restyle state-advance arrows; leave electron-flow geometry unchanged."""
    root = ET.fromstring(svg)
    for parent in list(root.iter()):
        children = list(parent)
        for index, child in enumerate(children):
            if child.get('class') != 'reaction-arrow':
                continue
            head = children[index+1]
            if head.get('class') != 'reaction-head':
                raise ValueError('Unexpected mechanism reaction arrow.')
            vals = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', child.get('d', ''))]
            pts = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', head.get('points', ''))]
            x1, y = vals[:2]
            x2 = max(pts[::2])
            slot = list(parent).index(child)
            parent.remove(child)
            parent.remove(head)
            group = ET.fromstring(f'<svg xmlns="{NS}">' + graphics(x1, y, x2) + '</svg>')
            for j, element in enumerate(group):
                parent.insert(slot+j, element)
    return ET.tostring(root, encoding='unicode').replace('Arial,Helvetica,sans-serif', "'Times New Roman',serif")


def install():
    figure_style.rdMolDraw2D.MolDraw2DSVG = fixed_drawer
    figure_style.rdMolDraw2D.PrepareAndDrawMolecule = prepare_and_draw
    figure_style.FIGURE_PRESETS['acs'].update(bond_length_px=BOND, bond_line_width=LINE)
    route_figure.render_molecule = compact_molecule
    mechanism_scene.render_molecule = compact_molecule
    route_figure.MOL_GAP, route_figure.ROW_GAP = 3, 10
    route_figure.TOP_MARGIN, route_figure.LEFT_MARGIN, route_figure.RIGHT_MARGIN = 14, 4, 4
    route_figure.MIN_MOL_CELL = 24
    route_figure._prepare_row = prepare
    route_figure._arrow_width_for = arrow_width
    route_figure._arrow_svg = arrow
    route_figure._compose_svg = compose
