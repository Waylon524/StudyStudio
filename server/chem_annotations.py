"""Selective explicit hydrogens, carbon display, and collision-aware molecule annotations."""
from __future__ import annotations

import math
import re
from html import escape
from typing import Any
from xml.etree import ElementTree as ET

import cairocffi as cairo
from rdkit import Chem
from rdkit.Chem import rdCoordGen, rdDepictor
from rdkit.Chem.Draw import rdMolDraw2D

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)

TNR = '/System/Library/Fonts/Supplemental/Times New Roman.ttf'
ATOM_FONT = 13.0
ANNOT_FONT = 12.0
CAPTION_FONT = 12.5
SCRIPT_RATIO = 0.65
BOND_PX = 24.0
LINE_PX = 0.8

HEAD_LENGTH = 5.8
HEAD_HALF_HEIGHT = 1.9
HEAD_NOTCH = 1.25
BASE_POINTER_LEN = 17.0

_cairo_ctx = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1))

NAMED_COLORS = {
    'black': '#000000',
    'red': '#c0392b',
    'crimson': '#c0392b',
    'blue': '#1d4ed8',
    'green': '#15803d',
    'orange': '#b45309',
    'amber': '#b45309',
    'purple': '#7c3aed',
    'gray': '#555555',
    'grey': '#555555',
}

DIRECTIONS: dict[str, tuple[float, float]] = {
    'top': (0.0, -1.0),
    'bottom': (0.0, 1.0),
    'left': (-1.0, 0.0),
    'right': (1.0, 0.0),
    'top-left': (-0.70710678, -0.70710678),
    'top-right': (0.70710678, -0.70710678),
    'bottom-left': (-0.70710678, 0.70710678),
    'bottom-right': (0.70710678, 0.70710678),
}

DIRECTION_ALIASES = {
    'up': 'top',
    'above': 'top',
    'north': 'top',
    'n': 'top',
    'down': 'bottom',
    'below': 'bottom',
    'south': 'bottom',
    's': 'bottom',
    'west': 'left',
    'w': 'left',
    'east': 'right',
    'e': 'right',
    'nw': 'top-left',
    'top_left': 'top-left',
    'topleft': 'top-left',
    'upper-left': 'top-left',
    'ne': 'top-right',
    'top_right': 'top-right',
    'topright': 'top-right',
    'upper-right': 'top-right',
    'sw': 'bottom-left',
    'bottom_left': 'bottom-left',
    'bottomleft': 'bottom-left',
    'lower-left': 'bottom-left',
    'se': 'bottom-right',
    'bottom_right': 'bottom-right',
    'bottomright': 'bottom-right',
    'lower-right': 'bottom-right',
}

SUB_MAP = dict(zip(
    '₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₒₓₕₖₗₘₙₚₛₜ',
    '0123456789+-aeoxhklmnpst',
))
SUP_MAP = dict(zip(
    '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻',
    '0123456789+-',
))

_NUMBER_RE = re.compile(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?')
_FONT_SIZE_RE = re.compile(r'font-size\s*:\s*(\d+(?:\.\d+)?)px')
_HEX_COLOR_RE = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')


def resolve_color(value: Any, default: str = '#000000') -> str:
    if value is None or value == '':
        return default
    if not isinstance(value, str):
        raise ValueError('Annotation color must be a string.')
    key = value.strip()
    lowered = key.lower()
    if lowered in NAMED_COLORS:
        return NAMED_COLORS[lowered]
    if _HEX_COLOR_RE.match(key):
        return key
    raise ValueError(f'Unsupported annotation color: {value}')


def normalize_position(value: Any, default: str = 'auto') -> str:
    if value is None or value == '':
        return default
    if not isinstance(value, str):
        raise ValueError('Annotation position must be a string.')
    key = value.strip().lower().replace(' ', '-')
    if key == 'auto':
        return 'auto'
    key = DIRECTION_ALIASES.get(key, key)
    if key not in DIRECTIONS:
        raise ValueError(f'Unsupported annotation position: {value}')
    return key


def parse_smiles_preserve_h(smiles: str) -> Chem.Mol:
    """Parse one SMILES string while retaining every explicitly written [H]."""
    if not isinstance(smiles, str) or not smiles.strip() or '>' in smiles:
        raise ValueError('Molecule requires one valid SMILES string.')
    params = Chem.SmilesParserParams()
    params.removeHs = False
    params.parseName = False
    mol = Chem.MolFromSmiles(smiles.strip(), params)
    if mol is None or mol.GetNumAtoms() == 0:
        raise ValueError(f'Invalid molecule SMILES: {smiles}')
    return mol


def _parse_positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f'{field_name} must be a positive integer.')
    if isinstance(value, int):
        num = value
    elif isinstance(value, str) and value.strip().isdigit():
        num = int(value.strip())
    else:
        raise ValueError(f'{field_name} must be a positive integer.')
    if num <= 0:
        raise ValueError(f'{field_name} must be a positive integer.')
    return num


def _parse_bond_pair(value: Any, field_name: str) -> tuple[int, int]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f'{field_name} must be a 2-element list of atom map numbers.')
    a = _parse_positive_int(value[0], field_name)
    b = _parse_positive_int(value[1], field_name)
    if a == b:
        raise ValueError(f'{field_name} must reference two distinct atoms.')
    return a, b


def _normalize_annotation(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f'Annotation #{index + 1} must be an object.')
    raw_type = str(raw.get('type') or ('pointer' if raw.get('arrow') else 'label')).strip().lower()
    type_aliases = {
        'label': 'label',
        'tag': 'label',
        'text': 'label',
        'pointer': 'pointer',
        'arrow': 'pointer',
        'callout': 'pointer',
        'highlight': 'highlight',
        'circle': 'highlight',
        'connector': 'connector',
        'link': 'connector',
    }
    if raw_type not in type_aliases:
        raise ValueError(f'Unsupported annotation type: {raw.get("type")}')
    kind = type_aliases[raw_type]

    if kind in ('label', 'pointer'):
        has_atom = raw.get('atom_map') is not None
        has_bond = raw.get('bond') is not None
        if has_atom == has_bond:
            raise ValueError(f'Annotation #{index + 1} ({kind}) requires either atom_map or bond.')
        target_atom = _parse_positive_int(raw['atom_map'], 'atom_map') if has_atom else None
        target_bond = _parse_bond_pair(raw['bond'], 'bond') if has_bond else None
        text = '' if raw.get('text') is None else str(raw.get('text')).strip()
        if kind == 'label' and not text:
            raise ValueError(f'Label annotation #{index + 1} requires non-empty text.')
        position = normalize_position(raw.get('position') or raw.get('side'), 'auto')
        color = resolve_color(raw.get('color'), '#000000')
        entry: dict[str, Any] = {
            'type': kind,
            'atom_map': target_atom,
            'bond': target_bond,
            'text': text,
            'position': position,
            'color': color,
        }
        if kind == 'pointer':
            style = str(raw.get('style') or 'solid').strip().lower()
            if style not in ('solid', 'dashed'):
                raise ValueError(f'Unsupported pointer style: {style}')
            raw_len = raw.get('length', 1.0)
            if isinstance(raw_len, bool) or not isinstance(raw_len, (int, float)) or not math.isfinite(raw_len):
                raise ValueError('Pointer length must be a finite number.')
            entry['style'] = style
            entry['length'] = max(0.55, min(2.4, float(raw_len)))
        return entry

    if kind == 'highlight':
        atom_maps: list[int] = []
        if raw.get('atom_map') is not None:
            atom_maps.append(_parse_positive_int(raw['atom_map'], 'atom_map'))
        if raw.get('atom_maps') is not None:
            if not isinstance(raw['atom_maps'], list) or not raw['atom_maps']:
                raise ValueError('highlight atom_maps must be a non-empty list of atom map numbers.')
            atom_maps.extend(_parse_positive_int(m, 'atom_maps') for m in raw['atom_maps'])
        bond = _parse_bond_pair(raw['bond'], 'bond') if raw.get('bond') is not None else None
        if not atom_maps and bond is None:
            raise ValueError(f'Highlight annotation #{index + 1} requires atom_map, atom_maps, or bond.')
        default_style = 'circle' if raw_type == 'circle' else 'halo'
        style = str(raw.get('style') or default_style).strip().lower()
        if style not in ('halo', 'circle', 'dashed_circle'):
            raise ValueError(f'Unsupported highlight style: {style}')
        default_color = '#000000' if style in ('circle', 'dashed_circle') and raw_type == 'circle' else '#c0392b'
        color = resolve_color(raw.get('color'), default_color)
        return {
            'type': 'highlight',
            'atom_maps': list(dict.fromkeys(atom_maps)),
            'bond': bond,
            'style': style,
            'color': color,
        }

    # connector
    from_atom = _parse_positive_int(raw['from_atom_map'], 'from_atom_map') if raw.get('from_atom_map') is not None else None
    from_bond = _parse_bond_pair(raw['from_bond'], 'from_bond') if raw.get('from_bond') is not None else None
    to_atom = _parse_positive_int(raw['to_atom_map'], 'to_atom_map') if raw.get('to_atom_map') is not None else None
    to_bond = _parse_bond_pair(raw['to_bond'], 'to_bond') if raw.get('to_bond') is not None else None
    if (from_atom is None) == (from_bond is None):
        raise ValueError(f'Connector annotation #{index + 1} requires from_atom_map or from_bond.')
    if (to_atom is None) == (to_bond is None):
        raise ValueError(f'Connector annotation #{index + 1} requires to_atom_map or to_bond.')
    if from_atom is not None and to_atom is not None and from_atom == to_atom:
        raise ValueError(f'Connector annotation #{index + 1} must connect two different targets.')
    style = str(raw.get('style') or 'dashed').strip().lower()
    if style not in ('dashed', 'solid', 'arrow', 'double_arrow', 'curved_arrow', 'curved_double_arrow'):
        raise ValueError(f'Unsupported connector style: {style}')
    side = normalize_position(raw.get('side') or raw.get('position'), 'auto')
    text = '' if raw.get('text') is None else str(raw.get('text')).strip()
    color = resolve_color(raw.get('color'), '#000000')
    return {
        'type': 'connector',
        'from_atom_map': from_atom,
        'from_bond': from_bond,
        'to_atom_map': to_atom,
        'to_bond': to_bond,
        'style': style,
        'side': side,
        'text': text,
        'color': color,
    }


def _collect_map_indices(mol: Chem.Mol) -> dict[int, list[int]]:
    mapping: dict[int, list[int]] = {}
    for atom in mol.GetAtoms():
        m = atom.GetIntProp('_annot_map') if atom.HasProp('_annot_map') else atom.GetAtomMapNum()
        if m > 0:
            mapping.setdefault(m, []).append(atom.GetIdx())
    return mapping


def _require_unique_map(mapping: dict[int, list[int]], atom_map: int) -> int:
    indices = mapping.get(atom_map)
    if not indices:
        raise ValueError(f'Annotation references unknown atom_map {atom_map}.')
    if len(indices) > 1:
        raise ValueError(f'Atom map {atom_map} appears multiple times; use unique atom map numbers for annotated atoms.')
    return indices[0]


def _set_carbon_display_label(atom: Chem.Atom) -> None:
    if atom.GetAtomicNum() != 6 or atom.GetFormalCharge() != 0 or atom.GetIsotope() != 0:
        return
    nh = atom.GetTotalNumHs()
    if nh == 0:
        atom.SetProp('_displayLabel', 'C')
        atom.SetProp('_displayLabelW', 'C')
    elif nh == 1:
        atom.SetProp('_displayLabel', 'CH')
        atom.SetProp('_displayLabelW', 'HC')
    else:
        atom.SetProp('_displayLabel', f'CH<sub>{nh}</sub>')
        atom.SetProp('_displayLabelW', f'H<sub>{nh}</sub>C')


def prepare_molecule_spec(spec: str | dict[str, Any]) -> tuple[Chem.Mol, dict[str, Any]]:
    """Parse, expand selective explicit Hs, apply carbon display labels, and validate annotations."""
    if isinstance(spec, str):
        mol = parse_smiles_preserve_h(spec)
        return mol, {
            'explicit_methyl': False,
            'show_carbons': 'skeletal',
            'annotations': [],
            'caption': '',
        }
    if not isinstance(spec, dict):
        raise ValueError('Molecule requires a SMILES string or a molecule specification object.')

    smiles = spec.get('smiles')
    if not isinstance(smiles, str) or not smiles.strip() or '>' in smiles:
        raise ValueError('Molecule specification requires a valid SMILES string in "smiles".')

    mol = parse_smiles_preserve_h(smiles)
    for atom in mol.GetAtoms():
        if atom.GetAtomMapNum() > 0:
            atom.SetIntProp('_annot_map', atom.GetAtomMapNum())

    mapping = _collect_map_indices(mol)

    # 1. Optional selective H expansion (on top of any [H] already written in SMILES)
    explicit_h = spec.get('explicit_h')
    uses_map_controls = False
    if explicit_h is not None:
        if explicit_h == 'all':
            mol = Chem.AddHs(mol)
        elif isinstance(explicit_h, list):
            uses_map_controls = True
            target_indices: list[int] = []
            for raw_map in explicit_h:
                m = _parse_positive_int(raw_map, 'explicit_h')
                if m not in mapping:
                    raise ValueError(f'explicit_h references unknown atom_map {m}.')
                target_indices.extend(mapping[m])
            if target_indices:
                mol = Chem.AddHs(mol, onlyOnAtoms=sorted(set(target_indices)))
        elif isinstance(explicit_h, dict):
            uses_map_controls = True
            additions: list[tuple[int, int]] = []
            for raw_map, raw_count in explicit_h.items():
                m = _parse_positive_int(raw_map, 'explicit_h')
                if m not in mapping:
                    raise ValueError(f'explicit_h references unknown atom_map {m}.')
                if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 0:
                    raise ValueError(f'explicit_h count for atom_map {m} must be a non-negative integer.')
                for idx in mapping[m]:
                    avail = mol.GetAtomWithIdx(idx).GetTotalNumHs()
                    if raw_count > avail:
                        raise ValueError(f'Atom map {m} only has {avail} implicit hydrogen(s); cannot split {raw_count}.')
                    if raw_count > 0:
                        additions.append((idx, raw_count))
            if additions:
                rw = Chem.RWMol(mol)
                for idx, count in additions:
                    atom = rw.GetAtomWithIdx(idx)
                    rem_explicit = atom.GetNumExplicitHs()
                    if rem_explicit > 0:
                        atom.SetNumExplicitHs(max(0, rem_explicit - count))
                    for _ in range(count):
                        h_idx = rw.AddAtom(Chem.Atom(1))
                        rw.AddBond(idx, h_idx, Chem.BondType.SINGLE)
                mol = rw.GetMol()
                Chem.SanitizeMol(mol)
        else:
            raise ValueError('explicit_h must be "all", a list of atom_map numbers, or a {atom_map: count} object.')

    mapping = _collect_map_indices(mol)

    # 2. Carbon display mode
    show_carbons = spec.get('show_carbons')
    if show_carbons is None and spec.get('explicit_methyl'):
        show_carbons = 'methyl'
    explicit_methyl = False
    if show_carbons is None or show_carbons == 'skeletal':
        normalized_carbons = 'skeletal'
    elif show_carbons in ('methyl', 'terminal'):
        normalized_carbons = 'methyl'
        explicit_methyl = True
    elif show_carbons == 'all':
        normalized_carbons = 'all'
        for atom in mol.GetAtoms():
            _set_carbon_display_label(atom)
    elif show_carbons in ('non_ring', 'acyclic'):
        normalized_carbons = 'non_ring'
        for atom in mol.GetAtoms():
            if not atom.IsInRing():
                _set_carbon_display_label(atom)
    elif isinstance(show_carbons, list):
        uses_map_controls = True
        normalized_carbons = 'selected'
        for raw_map in show_carbons:
            m = _parse_positive_int(raw_map, 'show_carbons')
            if m not in mapping:
                raise ValueError(f'show_carbons references unknown atom_map {m}.')
            for idx in mapping[m]:
                _set_carbon_display_label(mol.GetAtomWithIdx(idx))
    else:
        raise ValueError('show_carbons must be "skeletal", "methyl", "non_ring", "all", or a list of atom_map numbers.')

    # 3. Validate annotations
    raw_annotations = spec.get('annotations')
    annotations: list[dict[str, Any]] = []
    if raw_annotations is not None:
        if not isinstance(raw_annotations, list):
            raise ValueError('annotations must be a list.')
        if len(raw_annotations) > 40:
            raise ValueError('Too many annotations on one molecule (max 40).')
        annotations = [_normalize_annotation(item, i) for i, item in enumerate(raw_annotations)]

    if annotations:
        uses_map_controls = True
        for entry in annotations:
            if entry['type'] in ('label', 'pointer'):
                if entry['atom_map'] is not None:
                    _require_unique_map(mapping, entry['atom_map'])
                else:
                    i1 = _require_unique_map(mapping, entry['bond'][0])
                    i2 = _require_unique_map(mapping, entry['bond'][1])
                    if mol.GetBondBetweenAtoms(i1, i2) is None:
                        raise ValueError(f'No bond exists between atom_map {entry["bond"][0]} and {entry["bond"][1]}.')
            elif entry['type'] == 'highlight':
                for m in entry['atom_maps']:
                    if m not in mapping:
                        raise ValueError(f'Highlight references unknown atom_map {m}.')
                if entry['bond'] is not None:
                    i1 = _require_unique_map(mapping, entry['bond'][0])
                    i2 = _require_unique_map(mapping, entry['bond'][1])
                    if mol.GetBondBetweenAtoms(i1, i2) is None:
                        raise ValueError(f'No bond exists between atom_map {entry["bond"][0]} and {entry["bond"][1]}.')
            elif entry['type'] == 'connector':
                for key_atom, key_bond in (('from_atom_map', 'from_bond'), ('to_atom_map', 'to_bond')):
                    if entry[key_atom] is not None:
                        _require_unique_map(mapping, entry[key_atom])
                    else:
                        i1 = _require_unique_map(mapping, entry[key_bond][0])
                        i2 = _require_unique_map(mapping, entry[key_bond][1])
                        if mol.GetBondBetweenAtoms(i1, i2) is None:
                            raise ValueError(f'No bond exists between atom_map {entry[key_bond][0]} and {entry[key_bond][1]}.')

    # 4. Hide atom map numbers on drawn atoms when maps are used as anchors
    hide_atom_maps = spec.get('hide_atom_maps')
    if hide_atom_maps is None:
        hide_atom_maps = uses_map_controls
    elif not isinstance(hide_atom_maps, bool):
        raise ValueError('hide_atom_maps must be a boolean.')
    if hide_atom_maps:
        for atom in mol.GetAtoms():
            atom.SetAtomMapNum(0)

    caption = '' if spec.get('caption') is None else str(spec.get('caption')).strip()
    return mol, {
        'explicit_methyl': explicit_methyl,
        'show_carbons': normalized_carbons,
        'annotations': annotations,
        'caption': caption,
    }


def parse_annotation_runs(value: str) -> list[tuple[str, str, str]]:
    """Parse text with optional _sub / ^sup / δ± / Unicode scripts into (kind, family, text) runs."""
    text = str(value).replace('℃', '°C')
    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in ('_', '^') and i + 1 < n:
            kind = 'sub' if ch == '_' else 'sup'
            if text[i + 1] == '{':
                end = text.find('}', i + 2)
                if end != -1:
                    inner = text[i + 2:end]
                    if inner:
                        tokens.append((kind, inner.replace('-', '−') if kind == 'sup' and inner in ('-', '2-', '3-') else inner))
                    i = end + 1
                    continue
            nxt = text[i + 1]
            if nxt.isalnum() or nxt in '+-−αβγδ':
                tokens.append((kind, '−' if kind == 'sup' and nxt == '-' else nxt))
                i += 2
                continue
        if ch == 'δ' and i + 1 < n and text[i + 1] in ('+', '-', '−'):
            tokens.append(('normal', 'δ'))
            tokens.append(('sup', '+' if text[i + 1] == '+' else '−'))
            i += 2
            continue
        if ch in SUB_MAP:
            tokens.append(('sub', SUB_MAP[ch]))
        elif ch in SUP_MAP:
            c = SUP_MAP[ch]
            tokens.append(('sup', '−' if c == '-' else c))
        else:
            tokens.append(('normal', ch))
        i += 1

    runs: list[list[str]] = []
    for kind, chunk in tokens:
        for ch in chunk:
            family = 'Songti SC' if ord(ch) >= 0x2e80 else 'Times New Roman'
            if runs and runs[-1][0] == kind and runs[-1][1] == family:
                runs[-1][2] += ch
            else:
                runs.append([kind, family, ch])
    return [(r[0], r[1], r[2]) for r in runs]


def measure_text(value: str, size: float = ANNOT_FONT) -> tuple[float, float, float]:
    """Return (width, top_above_baseline, bottom_below_baseline) using Cairo extents."""
    runs = parse_annotation_runs(value)
    if not runs:
        return 0.0, 0.0, 0.0
    width = 0.0
    top = 0.0
    bottom = 0.0
    for kind, family, chunk in runs:
        fs = size if kind == 'normal' else size * SCRIPT_RATIO
        offset = size * 0.25 if kind == 'sub' else -size * 0.36 if kind == 'sup' else 0.0
        _cairo_ctx.select_font_face(family)
        _cairo_ctx.set_font_size(fs)
        _, y_b, _, h, adv, _ = _cairo_ctx.text_extents(chunk)
        width += adv
        top = min(top, y_b + offset)
        bottom = max(bottom, y_b + h + offset)
    return width, top, bottom


def build_text_svg(
    cx: float,
    cy: float,
    value: str,
    color: str = '#000000',
    size: float = ANNOT_FONT,
    cls: str = 'chem-annotation-label',
) -> tuple[str, tuple[float, float, float, float]]:
    """Render formatted text centered visually at (cx, cy). Returns (svg, ink_box)."""
    runs = parse_annotation_runs(value)
    w, top, bottom = measure_text(value, size)
    h = bottom - top
    x = cx - w / 2.0
    baseline = cy - h / 2.0 - top
    spans: list[str] = []
    cursor = x
    for kind, family, chunk in runs:
        fs = size if kind == 'normal' else size * SCRIPT_RATIO
        offset = size * 0.25 if kind == 'sub' else -size * 0.36 if kind == 'sup' else 0.0
        spans.append(
            f'<tspan x="{cursor:.2f}" y="{baseline + offset:.2f}" '
            f'font-size="{fs:.2f}" font-family="{family}" font-weight="normal" '
            f'fill="{color}">{escape(chunk)}</tspan>'
        )
        _cairo_ctx.select_font_face(family)
        _cairo_ctx.set_font_size(fs)
        cursor += _cairo_ctx.text_extents(chunk)[4]
    svg = (
        f'<text x="{x:.2f}" y="{baseline:.2f}" class="{cls}" '
        f'text-anchor="start" style="fill:{color};stroke:none">{"".join(spans)}</text>'
    )
    box = (x, baseline + top, x + w, baseline + bottom)
    return svg, box


def _unit(vx: float, vy: float) -> tuple[float, float]:
    length = math.hypot(vx, vy)
    return (vx / length, vy / length) if length > 1e-9 else (0.0, -1.0)


def _box_center(box: tuple[float, float, float, float]) -> tuple[float, float]:
    return (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0


def _union_boxes(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _intersection_area(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    dx = min(a[2], b[2]) - max(a[0], b[0])
    dy = min(a[3], b[3]) - max(a[1], b[1])
    return dx * dy if dx > 0.0 and dy > 0.0 else 0.0


def _box_distance(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    dx = max(0.0, a[0] - b[2], b[0] - a[2])
    dy = max(0.0, a[1] - b[3], b[1] - a[3])
    return math.hypot(dx, dy)


def _point_to_segment_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = max(0.0, min(1.0, (vx * wx + vy * wy) / denom)) if denom > 1e-9 else 0.0
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _point_to_box_distance(px: float, py: float, box: tuple[float, float, float, float]) -> float:
    dx = max(0.0, box[0] - px, px - box[2])
    dy = max(0.0, box[1] - py, py - box[3])
    return math.hypot(dx, dy)


def _segment_to_box_distance(
    ax: float, ay: float, bx: float, by: float, box: tuple[float, float, float, float]
) -> float:
    # Sample 9 points along the segment plus check box corners against segment: fast and accurate.
    best = min(
        _point_to_segment_distance(box[0], box[1], ax, ay, bx, by),
        _point_to_segment_distance(box[2], box[1], ax, ay, bx, by),
        _point_to_segment_distance(box[0], box[3], ax, ay, bx, by),
        _point_to_segment_distance(box[2], box[3], ax, ay, bx, by),
    )
    for k in range(9):
        t = k / 8.0
        px = ax + t * (bx - ax)
        py = ay + t * (by - ay)
        d = _point_to_box_distance(px, py, box)
        if d < best:
            best = d
            if best == 0.0:
                return 0.0
    return best


def _segments_intersect(
    a1: tuple[float, float], a2: tuple[float, float],
    b1: tuple[float, float], b2: tuple[float, float],
) -> bool:
    def orient(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    o1 = orient(a1, a2, b1)
    o2 = orient(a1, a2, b2)
    o3 = orient(b1, b2, a1)
    o4 = orient(b1, b2, a2)
    if (o1 > 1e-6 and o2 < -1e-6 or o1 < -1e-6 and o2 > 1e-6) and (
        o3 > 1e-6 and o4 < -1e-6 or o3 < -1e-6 and o4 > 1e-6
    ):
        return True
    return False


def _ray_box_exit(
    box: tuple[float, float, float, float], origin: tuple[float, float], ux: float, uy: float
) -> float:
    ox, oy = origin
    ts: list[float] = []
    if abs(ux) > 1e-9:
        tx = (box[2] - ox) / ux if ux > 0 else (box[0] - ox) / ux
        if tx >= 0:
            ts.append(tx)
    if abs(uy) > 1e-9:
        ty = (box[3] - oy) / uy if uy > 0 else (box[1] - oy) / uy
        if ty >= 0:
            ts.append(ty)
    return min(ts) if ts else 0.0


def _place_rect_outside(
    origin: tuple[float, float], ux: float, uy: float, start_dist: float, w: float, h: float
) -> tuple[float, float, tuple[float, float, float, float]]:
    """Place a w x h box so its nearest boundary along unit vector (ux, uy) is at start_dist."""
    hw, hh = w / 2.0, h / 2.0
    tx = hw / abs(ux) if abs(ux) > 1e-6 else float('inf')
    ty = hh / abs(uy) if abs(uy) > 1e-6 else float('inf')
    ray_half = min(tx, ty)
    cx = origin[0] + ux * (start_dist + ray_half)
    cy = origin[1] + uy * (start_dist + ray_half)
    return cx, cy, (cx - hw, cy - hh, cx + hw, cy + hh)


def _place_rect_halfspace(
    origin: tuple[float, float], nx: float, ny: float, gap: float, w: float, h: float
) -> tuple[float, float, tuple[float, float, float, float]]:
    """Place a w x h box strictly in the half-space (p - origin)·n >= gap."""
    hw, hh = w / 2.0, h / 2.0
    support = abs(nx) * hw + abs(ny) * hh
    cx = origin[0] + nx * (gap + support)
    cy = origin[1] + ny * (gap + support)
    return cx, cy, (cx - hw, cy - hh, cx + hw, cy + hh)


def _arrowhead_polygon(
    tip: tuple[float, float], dx: float, dy: float, color: str
) -> tuple[str, tuple[float, float, float, float]]:
    nx, ny = -dy, dx
    w1 = (tip[0] - HEAD_LENGTH * dx + HEAD_HALF_HEIGHT * nx, tip[1] - HEAD_LENGTH * dy + HEAD_HALF_HEIGHT * ny)
    notch = (tip[0] - (HEAD_LENGTH - HEAD_NOTCH) * dx, tip[1] - (HEAD_LENGTH - HEAD_NOTCH) * dy)
    w2 = (tip[0] - HEAD_LENGTH * dx - HEAD_HALF_HEIGHT * nx, tip[1] - HEAD_LENGTH * dy - HEAD_HALF_HEIGHT * ny)
    d = f'M {tip[0]:.2f} {tip[1]:.2f} L {w1[0]:.2f} {w1[1]:.2f} L {notch[0]:.2f} {notch[1]:.2f} L {w2[0]:.2f} {w2[1]:.2f} Z'
    svg = f'<path d="{d}" class="chem-annotation-head" style="fill:{color};stroke:none"/>'
    pts = [tip, w1, notch, w2]
    box = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    return svg, box


def _draw_straight_arrow(
    tail: tuple[float, float],
    tip: tuple[float, float],
    color: str,
    dashed: bool = False,
    double_headed: bool = False,
) -> tuple[str, tuple[float, float, float, float]]:
    dx, dy = _unit(tip[0] - tail[0], tip[1] - tail[1])
    trim_end = HEAD_LENGTH - HEAD_NOTCH
    shaft_end = (tip[0] - trim_end * dx, tip[1] - trim_end * dy)
    shaft_start = (tail[0] + trim_end * dx, tail[1] + trim_end * dy) if double_headed else tail
    dash_css = 'stroke-dasharray:3,2;' if dashed else ''
    parts = [
        f'<path d="M {shaft_start[0]:.2f} {shaft_start[1]:.2f} L {shaft_end[0]:.2f} {shaft_end[1]:.2f}" '
        f'class="chem-annotation-arrow" style="fill:none;stroke:{color};stroke-width:{LINE_PX};'
        f'stroke-linecap:butt;stroke-linejoin:miter;{dash_css}"/>'
    ]
    boxes = [(
        min(tail[0], tip[0]) - LINE_PX,
        min(tail[1], tip[1]) - LINE_PX,
        max(tail[0], tip[0]) + LINE_PX,
        max(tail[1], tip[1]) + LINE_PX,
    )]
    head_svg, head_box = _arrowhead_polygon(tip, dx, dy, color)
    parts.append(head_svg)
    boxes.append(head_box)
    if double_headed:
        h2_svg, h2_box = _arrowhead_polygon(tail, -dx, -dy, color)
        parts.append(h2_svg)
        boxes.append(h2_box)
    return ''.join(parts), _union_boxes(boxes)


def extract_atom_boxes_from_svg(
    root: ET.Element,
    atom_points: list[tuple[float, float]],
    existing_path_boxes: dict[int, list[tuple[float, float, float, float]]] | None = None,
) -> dict[int, tuple[float, float, float, float]]:
    """Compute exact per-atom ink boxes from either <text> or <path> RDKit SVG output."""
    per_atom: dict[int, list[tuple[float, float, float, float]]] = {}
    if existing_path_boxes:
        for idx, boxes in existing_path_boxes.items():
            per_atom.setdefault(idx, []).extend(boxes)

    for el in root.iter():
        cls = el.attrib.get('class', '')
        m = re.match(r'^atom-(\d+)$', cls)
        if not m:
            continue
        idx = int(m.group(1))
        tag = el.tag.rsplit('}', 1)[-1]
        if tag == 'text' and el.text:
            x = float(el.attrib.get('x', '0'))
            y = float(el.attrib.get('y', '0'))
            style = el.attrib.get('style', '')
            fm = _FONT_SIZE_RE.search(style)
            fs = float(fm.group(1)) if fm else ATOM_FONT
            _cairo_ctx.select_font_face('Times New Roman')
            _cairo_ctx.set_font_size(fs)
            xb, yb, w, h, adv, _ = _cairo_ctx.text_extents(el.text)
            box = (x + min(0.0, xb), y + yb, x + max(xb + w, adv * 0.92), y + yb + h)
            per_atom.setdefault(idx, []).append(box)
        elif tag == 'path' and not existing_path_boxes:
            nums = [float(v) for v in _NUMBER_RE.findall(el.attrib.get('d', ''))]
            xs, ys = nums[0::2], nums[1::2]
            if xs and ys:
                per_atom.setdefault(idx, []).append((min(xs), min(ys), max(xs), max(ys)))

    result: dict[int, tuple[float, float, float, float]] = {}
    for idx, (ax, ay) in enumerate(atom_points):
        if idx in per_atom:
            result[idx] = _union_boxes(per_atom[idx])
        else:
            result[idx] = (ax - 2.5, ay - 2.5, ax + 2.5, ay + 2.5)
    return result


def render_annotations_overlay(
    mol: Chem.Mol,
    atom_points: list[tuple[float, float]],
    atom_boxes: dict[int, tuple[float, float, float, float]],
    annotations: list[dict[str, Any]],
    caption: str = '',
) -> tuple[str, str, list[tuple[float, float, float, float]], list[tuple[float, float, float, float]]]:
    """Layout and generate background & foreground SVG overlays for molecule annotations.

    Returns (bg_svg, fg_svg, all_boxes, text_boxes).
    """
    if not annotations and not caption:
        return '', '', [], []

    mapping = _collect_map_indices(mol)
    bonds: list[tuple[int, int, tuple[float, float], tuple[float, float]]] = [
        (b.GetBeginAtomIdx(), b.GetEndAtomIdx(), atom_points[b.GetBeginAtomIdx()], atom_points[b.GetEndAtomIdx()])
        for b in mol.GetBonds()
    ]

    bg_parts: list[str] = []
    fg_parts: list[str] = []
    all_boxes: list[tuple[float, float, float, float]] = []
    text_boxes: list[tuple[float, float, float, float]] = []
    placed_boxes: list[tuple[float, float, float, float]] = []
    placed_segments: list[tuple[tuple[float, float], tuple[float, float]]] = []

    def target_geometry(atom_map: int | None, bond_pair: tuple[int, int] | None):
        if atom_map is not None:
            idx = _require_unique_map(mapping, atom_map)
            box = atom_boxes[idx]
            center = _box_center(box)
            # Natural outward vector if degree-1 atom (e.g. explicit H or terminal group)
            atom = mol.GetAtomWithIdx(idx)
            outward = None
            if atom.GetDegree() == 1:
                nbr = atom.GetNeighbors()[0].GetIdx()
                outward = _unit(atom_points[idx][0] - atom_points[nbr][0], atom_points[idx][1] - atom_points[nbr][1])
            return center, box, {idx}, outward, None
        i1 = _require_unique_map(mapping, bond_pair[0])
        i2 = _require_unique_map(mapping, bond_pair[1])
        p1, p2 = atom_points[i1], atom_points[i2]
        mid = ((p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0)
        box = (mid[0] - 2.0, mid[1] - 2.0, mid[0] + 2.0, mid[1] + 2.0)
        dx, dy = _unit(p2[0] - p1[0], p2[1] - p1[1])
        return mid, box, {i1, i2}, (-dy, dx), (min(i1, i2), max(i1, i2))

    def score_candidate(
        cand_boxes: list[tuple[float, float, float, float]],
        cand_segs: list[tuple[tuple[float, float], tuple[float, float]]],
        target_indices: set[int],
        target_bond_key: tuple[int, int] | None,
        ux: float,
        uy: float,
        pref_vec: tuple[float, float] | None,
        cardinal_bonus: float,
        target_box: tuple[float, float, float, float] | None = None,
    ) -> float:
        cost = 0.0
        for cbox in cand_boxes:
            dist_to_target = _box_distance(cbox, target_box) if target_box is not None else None
            for idx, abox in atom_boxes.items():
                area = _intersection_area(cbox, abox)
                if area > 0.0:
                    cost += 2400.0 + 140.0 * area
                else:
                    dist = _box_distance(cbox, abox)
                    margin = 2.5 if idx in target_indices else 5.0
                    if dist < margin:
                        cost += (90.0 if idx not in target_indices else 15.0) * (margin - dist)
                    # A label should not sit closer to a non-target atom than to its own target.
                    if dist_to_target is not None and idx not in target_indices and dist + 0.5 < dist_to_target:
                        cost += 350.0 + 60.0 * (dist_to_target - dist)
            for pbox in placed_boxes:
                area = _intersection_area(cbox, pbox)
                if area > 0.0:
                    cost += 2400.0 + 140.0 * area
                else:
                    dist = _box_distance(cbox, pbox)
                    if dist < 4.0:
                        cost += 80.0 * (4.0 - dist)
            for u, v, pu, pv in bonds:
                d = _segment_to_box_distance(pu[0], pu[1], pv[0], pv[1], cbox)
                if d < 0.8:
                    cost += 2200.0 + 180.0 * (0.8 - d)
                elif d < 4.5:
                    cost += 160.0 * (4.5 - d)
            for q0, q1 in placed_segments:
                d = _segment_to_box_distance(q0[0], q0[1], q1[0], q1[1], cbox)
                if d < 0.8:
                    cost += 2000.0 + 160.0 * (0.8 - d)
                elif d < 4.0:
                    cost += 140.0 * (4.0 - d)
        for s0, s1 in cand_segs:
            for idx, abox in atom_boxes.items():
                if idx in target_indices:
                    continue
                d = _segment_to_box_distance(s0[0], s0[1], s1[0], s1[1], abox)
                if d < 0.8:
                    cost += 2200.0
                elif d < 4.0:
                    cost += 260.0 * (4.0 - d)
            for pbox in placed_boxes:
                d = _segment_to_box_distance(s0[0], s0[1], s1[0], s1[1], pbox)
                if d < 0.8:
                    cost += 2000.0
                elif d < 3.5:
                    cost += 220.0 * (3.5 - d)
            for u, v, pu, pv in bonds:
                if target_bond_key is not None and (min(u, v), max(u, v)) == target_bond_key:
                    continue
                if _segments_intersect(s0, s1, pu, pv):
                    cost += 2400.0
                else:
                    d = min(
                        _point_to_segment_distance(s0[0], s0[1], pu[0], pu[1], pv[0], pv[1]),
                        _point_to_segment_distance((s0[0] + s1[0]) / 2.0, (s0[1] + s1[1]) / 2.0, pu[0], pu[1], pv[0], pv[1]),
                        _point_to_segment_distance(s1[0], s1[1], pu[0], pu[1], pv[0], pv[1]),
                    )
                    if d < 4.5:
                        cost += 180.0 * (4.5 - d)
            for q0, q1 in placed_segments:
                if _segments_intersect(s0, s1, q0, q1):
                    cost += 1600.0
        if pref_vec is not None:
            dot = max(-1.0, min(1.0, ux * pref_vec[0] + uy * pref_vec[1]))
            cost += (1.0 - dot) * 45.0
        cost -= cardinal_bonus
        return cost

    def candidate_vectors(position: str, outward: tuple[float, float] | None, is_bond: bool):
        if position != 'auto':
            base = DIRECTIONS[position]
            ang = math.atan2(base[1], base[0])
            # Prefer exact requested direction, then progressive angular fallbacks if blocked by a bond.
            cands = [(base[0], base[1], 10.0)]
            for deg in (16, -16, 30, -30, 48, -48, 70, -70, 95, -95):
                r = ang + math.radians(deg)
                cands.append((math.cos(r), math.sin(r), 0.0))
            return cands, base
        cands: list[tuple[float, float, float]] = []
        if is_bond and outward is not None:
            cands.append((outward[0], outward[1], 4.0))
            cands.append((-outward[0], -outward[1], 4.0))
        elif outward is not None:
            cands.append((outward[0], outward[1], 3.5))
        for name, vec in DIRECTIONS.items():
            bonus = 2.5 if '-' not in name else 1.0
            cands.append((vec[0], vec[1], bonus))
        for deg in range(0, 360, 22):
            r = math.radians(deg)
            cands.append((math.cos(r), math.sin(r), 0.0))
        return cands, outward

    # Pass 1: Background highlights & circles
    for entry in annotations:
        if entry['type'] != 'highlight':
            continue
        style = entry['style']
        color = entry['color']
        for m in entry['atom_maps']:
            for idx in mapping[m]:
                box = atom_boxes[idx]
                cx, cy = _box_center(box)
                bw, bh = box[2] - box[0], box[3] - box[1]
                rx = max(6.5, bw / 2.0 + 3.2)
                ry = max(6.5, bh / 2.0 + 2.8)
                if abs(rx - ry) < 1.8:
                    r = max(rx, ry)
                    geom = f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}"'
                    hbox = (cx - r - 1.0, cy - r - 1.0, cx + r + 1.0, cy + r + 1.0)
                else:
                    geom = f'<ellipse cx="{cx:.2f}" cy="{cy:.2f}" rx="{rx:.2f}" ry="{ry:.2f}"'
                    hbox = (cx - rx - 1.0, cy - ry - 1.0, cx + rx + 1.0, cy + ry + 1.0)
                if style == 'halo':
                    bg_parts.append(f'{geom} class="chem-annotation-highlight" style="fill:{color};fill-opacity:0.2;stroke:none"/>')
                else:
                    dash = 'stroke-dasharray:2.8,2;' if style == 'dashed_circle' else ''
                    bg_parts.append(f'{geom} class="chem-annotation-highlight" style="fill:none;stroke:{color};stroke-width:0.95;{dash}"/>')
                all_boxes.append(hbox)
        if entry['bond'] is not None:
            i1 = _require_unique_map(mapping, entry['bond'][0])
            i2 = _require_unique_map(mapping, entry['bond'][1])
            p1, p2 = atom_points[i1], atom_points[i2]
            if style == 'halo':
                bg_parts.append(
                    f'<line x1="{p1[0]:.2f}" y1="{p1[1]:.2f}" x2="{p2[0]:.2f}" y2="{p2[1]:.2f}" '
                    f'class="chem-annotation-highlight" style="stroke:{color};stroke-width:6.5;stroke-opacity:0.22;stroke-linecap:round"/>'
                )
                pad = 3.5
            else:
                dash = 'stroke-dasharray:3,2;' if style == 'dashed_circle' else ''
                bg_parts.append(
                    f'<line x1="{p1[0]:.2f}" y1="{p1[1]:.2f}" x2="{p2[0]:.2f}" y2="{p2[1]:.2f}" '
                    f'class="chem-annotation-highlight" style="stroke:{color};stroke-width:2.0;stroke-opacity:0.75;stroke-linecap:round;{dash}"/>'
                )
                pad = 1.5
            all_boxes.append((min(p1[0], p2[0]) - pad, min(p1[1], p2[1]) - pad, max(p1[0], p2[0]) + pad, max(p1[1], p2[1]) + pad))

    # Pass 2: Explicit-position labels and pointers first, then auto-positioned ones
    ordered_point_annots = sorted(
        [a for a in annotations if a['type'] in ('label', 'pointer')],
        key=lambda a: (0 if a['position'] != 'auto' else 1, 0 if a['type'] == 'label' else 1),
    )

    for entry in ordered_point_annots:
        origin, tbox, target_indices, outward, bond_key = target_geometry(entry['atom_map'], entry['bond'])
        cands, pref = candidate_vectors(entry['position'], outward, entry['bond'] is not None)

        if entry['type'] == 'label':
            tw, ttop, tbot = measure_text(entry['text'], ANNOT_FONT)
            th = max(tbot - ttop, 8.0)
            best = None
            for ux, uy, bonus in cands:
                exit_d = _ray_box_exit(tbox, origin, ux, uy)
                for gap in (4.5, 8.0, 12.0):
                    cx, cy, rbox = _place_rect_outside(origin, ux, uy, exit_d + gap, tw, th)
                    cost = score_candidate([rbox], [], target_indices, bond_key, ux, uy, pref, bonus, target_box=tbox) + (gap - 4.5) * 4.0
                    if best is None or cost < best[0]:
                        best = (cost, cx, cy)
            _, cx, cy = best
            svg_el, ibox = build_text_svg(cx, cy, entry['text'], entry['color'], ANNOT_FONT)
            fg_parts.append(svg_el)
            all_boxes.append(ibox)
            text_boxes.append(ibox)
            placed_boxes.append(ibox)
        else:
            arrow_len = BASE_POINTER_LEN * entry['length']
            has_text = bool(entry['text'])
            tw, ttop, tbot = measure_text(entry['text'], ANNOT_FONT) if has_text else (0.0, 0.0, 0.0)
            th = max(tbot - ttop, 8.0) if has_text else 0.0
            best = None
            for ux, uy, bonus in cands:
                exit_d = _ray_box_exit(tbox, origin, ux, uy)
                tip_gap = 3.8
                for extra_len in (0.0, 6.0):
                    eff_len = arrow_len + extra_len
                    tip = (origin[0] + ux * (exit_d + tip_gap), origin[1] + uy * (exit_d + tip_gap))
                    tail = (tip[0] + ux * eff_len, tip[1] + uy * eff_len)
                    # Check arrowhead and shaft clearance against neighboring bonds/atoms.
                    seg_check = ((tip[0] + ux * 1.0, tip[1] + uy * 1.0), tail)
                    c_boxes: list[tuple[float, float, float, float]] = []
                    txt_center = None
                    if has_text:
                        tx, ty, trbox = _place_rect_outside(tail, ux, uy, 3.6, tw, th)
                        c_boxes.append(trbox)
                        txt_center = (tx, ty)
                    cost = (
                        score_candidate(c_boxes, [seg_check], target_indices, bond_key, ux, uy, pref, bonus)
                        + extra_len * 3.0
                    )
                    if best is None or cost < best[0]:
                        best = (cost, tail, tip, txt_center)
            _, tail, tip, txt_center = best
            arrow_svg, abox = _draw_straight_arrow(tail, tip, entry['color'], dashed=(entry['style'] == 'dashed'))
            fg_parts.append(arrow_svg)
            all_boxes.append(abox)
            placed_segments.append((tail, tip))
            placed_boxes.append(abox)
            if txt_center is not None:
                svg_el, ibox = build_text_svg(txt_center[0], txt_center[1], entry['text'], entry['color'], ANNOT_FONT)
                fg_parts.append(svg_el)
                all_boxes.append(ibox)
                text_boxes.append(ibox)
                placed_boxes.append(ibox)

    # Pass 3: Connectors (straight or curved lines/arrows between two mapped targets)
    for entry in annotations:
        if entry['type'] != 'connector':
            continue
        p0_orig, box0, idx0, _, _ = target_geometry(entry['from_atom_map'], entry['from_bond'])
        p1_orig, box1, idx1, _, _ = target_geometry(entry['to_atom_map'], entry['to_bond'])
        dx, dy = _unit(p1_orig[0] - p0_orig[0], p1_orig[1] - p0_orig[1])
        dist_total = math.hypot(p1_orig[0] - p0_orig[0], p1_orig[1] - p0_orig[1])
        if dist_total < 4.0:
            continue
        e0 = min(_ray_box_exit(box0, p0_orig, dx, dy) + 4.0, dist_total * 0.35)
        e1 = min(_ray_box_exit(box1, p1_orig, -dx, -dy) + 4.0, dist_total * 0.35)
        p0 = (p0_orig[0] + dx * e0, p0_orig[1] + dy * e0)
        p1 = (p1_orig[0] - dx * e1, p1_orig[1] - dy * e1)
        style = entry['style']
        color = entry['color']

        if style in ('dashed', 'solid', 'arrow', 'double_arrow'):
            if style in ('arrow', 'double_arrow'):
                c_svg, c_box = _draw_straight_arrow(p0, p1, color, dashed=False, double_headed=(style == 'double_arrow'))
            else:
                dash_css = 'stroke-dasharray:3.2,2.4;' if style == 'dashed' else ''
                c_svg = (
                    f'<path d="M {p0[0]:.2f} {p0[1]:.2f} L {p1[0]:.2f} {p1[1]:.2f}" '
                    f'class="chem-annotation-connector" style="fill:none;stroke:{color};'
                    f'stroke-width:{LINE_PX};stroke-linecap:round;{dash_css}"/>'
                )
                c_box = (min(p0[0], p1[0]) - 1.0, min(p0[1], p1[1]) - 1.0, max(p0[0], p1[0]) + 1.0, max(p0[1], p1[1]) + 1.0)
            fg_parts.append(c_svg)
            all_boxes.append(c_box)
            placed_segments.append((p0, p1))
            if entry['text']:
                mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
                tw, ttop, tbot = measure_text(entry['text'], ANNOT_FONT)
                th = max(tbot - ttop, 8.0)
                n1 = (-dy, dx)
                n2 = (dy, -dx)
                side_cands = [n1, n2]
                pref_side = DIRECTIONS[entry['side']] if entry['side'] != 'auto' else None
                best_txt = None
                for n in side_cands:
                    for gap in (4.0, 8.0, 12.0):
                        tx, ty, trbox = _place_rect_halfspace(mid, n[0], n[1], gap, tw, th)
                        sc = score_candidate([trbox], [], idx0 | idx1, None, n[0], n[1], pref_side, 0.0) + (gap - 4.0) * 4.0
                        if best_txt is None or sc < best_txt[0]:
                            best_txt = (sc, tx, ty)
                _, tx, ty = best_txt
                t_svg, t_box = build_text_svg(tx, ty, entry['text'], color, ANNOT_FONT)
                fg_parts.append(t_svg)
                all_boxes.append(t_box)
                text_boxes.append(t_box)
                placed_boxes.append(t_box)
        else:
            # Curved connector (curved_arrow / curved_double_arrow)
            chord = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            bend = max(14.0, min(36.0, chord * 0.34))
            mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
            normals = [(-dy, dx), (dy, -dx)]

            def curve_score(n: tuple[float, float]) -> float:
                ctrl = (mid[0] + n[0] * bend, mid[1] + n[1] * bend)
                cost = 0.0
                for k in range(1, 10):
                    t = k / 10.0
                    mt = 1.0 - t
                    qx = mt * mt * p0[0] + 2 * mt * t * ctrl[0] + t * t * p1[0]
                    qy = mt * mt * p0[1] + 2 * mt * t * ctrl[1] + t * t * p1[1]
                    for idx, abox in atom_boxes.items():
                        if idx in (idx0 | idx1):
                            continue
                        d = _point_to_box_distance(qx, qy, abox)
                        if d < 5.0:
                            cost += 120.0 * (5.0 - d)
                    for u, v, pu, pv in bonds:
                        d = _point_to_segment_distance(qx, qy, pu[0], pu[1], pv[0], pv[1])
                        if d < 4.5:
                            cost += 60.0 * (4.5 - d)
                return cost

            if entry['side'] != 'auto':
                sv = DIRECTIONS[entry['side']]
                chosen_n = max(normals, key=lambda n: n[0] * sv[0] + n[1] * sv[1])
            else:
                chosen_n = min(normals, key=curve_score)

            ctrl = (mid[0] + chosen_n[0] * bend, mid[1] + chosen_n[1] * bend)
            t_end = _unit(p1[0] - ctrl[0], p1[1] - ctrl[1])
            t_start = _unit(p0[0] - ctrl[0], p0[1] - ctrl[1])
            trim = HEAD_LENGTH - HEAD_NOTCH
            double_headed = style == 'curved_double_arrow'
            c_start = (p0[0] - trim * t_start[0], p0[1] - trim * t_start[1]) if double_headed else p0
            c_end = (p1[0] - trim * t_end[0], p1[1] - trim * t_end[1])
            path_svg = (
                f'<path d="M {c_start[0]:.2f} {c_start[1]:.2f} Q {ctrl[0]:.2f} {ctrl[1]:.2f} {c_end[0]:.2f} {c_end[1]:.2f}" '
                f'class="chem-annotation-connector" style="fill:none;stroke:{color};stroke-width:{LINE_PX};stroke-linecap:butt"/>'
            )
            fg_parts.append(path_svg)
            h1_svg, h1_box = _arrowhead_polygon(p1, t_end[0], t_end[1], color)
            fg_parts.append(h1_svg)
            curve_pts: list[tuple[float, float]] = [p0, p1]
            for k in range(1, 16):
                t = k / 16.0
                mt = 1.0 - t
                curve_pts.append((
                    mt * mt * p0[0] + 2 * mt * t * ctrl[0] + t * t * p1[0],
                    mt * mt * p0[1] + 2 * mt * t * ctrl[1] + t * t * p1[1],
                ))
            c_boxes = [
                (min(p[0] for p in curve_pts) - 1.0, min(p[1] for p in curve_pts) - 1.0,
                 max(p[0] for p in curve_pts) + 1.0, max(p[1] for p in curve_pts) + 1.0),
                h1_box,
            ]
            if double_headed:
                h2_svg, h2_box = _arrowhead_polygon(p0, t_start[0], t_start[1], color)
                fg_parts.append(h2_svg)
                c_boxes.append(h2_box)
            all_boxes.append(_union_boxes(c_boxes))
            if entry['text']:
                apex = (
                    0.25 * p0[0] + 0.5 * ctrl[0] + 0.25 * p1[0],
                    0.25 * p0[1] + 0.5 * ctrl[1] + 0.25 * p1[1],
                )
                tw, ttop, tbot = measure_text(entry['text'], ANNOT_FONT)
                th = max(tbot - ttop, 8.0)
                tx, ty, _ = _place_rect_halfspace(apex, chosen_n[0], chosen_n[1], 4.0, tw, th)
                t_svg, t_box = build_text_svg(tx, ty, entry['text'], color, ANNOT_FONT)
                fg_parts.append(t_svg)
                all_boxes.append(t_box)
                text_boxes.append(t_box)
                placed_boxes.append(t_box)

    # Pass 4: Optional standalone caption below the entire molecule + annotations
    if caption:
        ref_boxes = list(atom_boxes.values()) + all_boxes
        union = _union_boxes(ref_boxes)
        cw, ctop, cbot = measure_text(caption, CAPTION_FONT)
        ch = max(cbot - ctop, 10.0)
        cap_cx = (union[0] + union[2]) / 2.0
        cap_cy = union[3] + 8.0 + ch / 2.0
        cap_svg, cap_box = build_text_svg(cap_cx, cap_cy, caption, '#000000', CAPTION_FONT, cls='chem-caption')
        fg_parts.append(cap_svg)
        all_boxes.append(cap_box)
        text_boxes.append(cap_box)

    bg_svg = f'<g class="chem-annotation">{"".join(bg_parts)}</g>' if bg_parts else ''
    fg_svg = f'<g class="chem-annotation">{"".join(fg_parts)}</g>' if fg_parts else ''
    return bg_svg, fg_svg, all_boxes, text_boxes


def _usable_2d(mol: Chem.Mol) -> bool:
    if not mol.GetNumAtoms() or not mol.GetNumConformers():
        return False
    conf = mol.GetConformer()
    pts = [conf.GetAtomPosition(i) for i in range(mol.GetNumAtoms())]
    if not all(math.isfinite(v) for p in pts for v in (p.x, p.y, p.z)):
        return False
    return all((pts[b.GetBeginAtomIdx()] - pts[b.GetEndAtomIdx()]).Length() > 1e-6 for b in mol.GetBonds())


def _normalize_median_bond(mol: Chem.Mol, target_units: float = 1.0) -> None:
    if mol.GetNumBonds() == 0 or mol.GetNumConformers() == 0:
        return
    conf = mol.GetConformer()
    lengths = sorted(
        (conf.GetAtomPosition(b.GetBeginAtomIdx()) - conf.GetAtomPosition(b.GetEndAtomIdx())).Length()
        for b in mol.GetBonds()
    )
    median = lengths[len(lengths) // 2]
    if median <= 1e-6 or abs(median - target_units) < 1e-6:
        return
    scale = target_units / median
    for idx in range(mol.GetNumAtoms()):
        p = conf.GetAtomPosition(idx)
        conf.SetAtomPosition(idx, (p.x * scale, p.y * scale, 0.0))


def compute_clean_2d_coords(
    mol: Chem.Mol, *, target_bond_units: float = 1.0, prefer_horizontal: bool = False
) -> None:
    """Compute clean 2D coordinates with CoordGen and RDKit fallback for all-H species."""
    used_coordgen = False
    try:
        rdCoordGen.AddCoords(mol)
        used_coordgen = _usable_2d(mol)
    except Exception:
        used_coordgen = False
    if not used_coordgen:
        rdDepictor.Compute2DCoords(mol, clearConfs=True, forceRDKit=True)
        if not _usable_2d(mol):
            raise ValueError('Unable to generate finite molecule coordinates.')
    rdDepictor.StraightenDepiction(mol)
    if prefer_horizontal and mol.GetNumAtoms() > 2 and mol.GetNumConformers():
        conf = mol.GetConformer()
        xs = [conf.GetAtomPosition(i).x for i in range(mol.GetNumAtoms())]
        ys = [conf.GetAtomPosition(i).y for i in range(mol.GetNumAtoms())]
        if (max(ys) - min(ys)) > (max(xs) - min(xs)) * 1.15:
            # Rigid +90 deg rotation (det = +1) preserves all stereochemistry while laying chains horizontally.
            for idx in range(mol.GetNumAtoms()):
                p = conf.GetAtomPosition(idx)
                conf.SetAtomPosition(idx, (-p.y, p.x, 0.0))
    _normalize_median_bond(mol, target_units=target_bond_units)


def render_standalone_molecule_svg(spec: str | dict[str, Any]) -> tuple[str, list[str]]:
    """Render one standalone molecule (plain SMILES or annotated JSON spec) to clean vector SVG."""
    mol, opts_meta = prepare_molecule_spec(spec)
    # Give carbon-labeled structures extra breathing room so CH2/CH3 groups never crowd.
    if opts_meta['show_carbons'] == 'all':
        bond_units = 1.45
    elif opts_meta['show_carbons'] in ('non_ring', 'selected'):
        bond_units = 1.18
    else:
        bond_units = 1.05
    compute_clean_2d_coords(mol, target_bond_units=bond_units, prefer_horizontal=True)
    mol = rdMolDraw2D.PrepareMolForDrawing(mol)

    drawer = rdMolDraw2D.MolDraw2DSVG(-1, -1, -1, -1, True)
    options = drawer.drawOptions()
    options.fixedBondLength = BOND_PX
    options.fixedFontSize = int(ATOM_FONT)
    options.fontFile = TNR
    options.bondLineWidth = LINE_PX
    options.clearBackground = False
    options.padding = 0.08
    options.explicitMethyl = bool(opts_meta['explicit_methyl'])
    options.useBWAtomPalette()
    if mol.GetNumAtoms() and all(atom.GetAtomicNum() == 1 for atom in mol.GetAtoms()):
        options.centreMoleculesBeforeDrawing = False
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()

    svg_text = drawer.GetDrawingText().replace('sans-serif', 'Times New Roman')
    root = ET.fromstring(svg_text)
    atom_points = [(float(drawer.GetDrawCoords(i).x), float(drawer.GetDrawCoords(i).y)) for i in range(mol.GetNumAtoms())]
    atom_boxes = extract_atom_boxes_from_svg(root, atom_points)

    bg_svg, fg_svg, extra_boxes, _ = render_annotations_overlay(
        mol, atom_points, atom_boxes, opts_meta['annotations'], caption=opts_meta['caption']
    )

    if bg_svg:
        bg_el = ET.fromstring(f'<svg xmlns="{NS}">{bg_svg}</svg>')[0]
        # Insert after any background rect, before bonds/atoms.
        insert_at = 0
        for idx, child in enumerate(list(root)):
            tag = child.tag.rsplit('}', 1)[-1]
            if tag in ('rect', 'defs', 'style'):
                insert_at = idx + 1
            else:
                break
        root.insert(insert_at, bg_el)
    if fg_svg:
        fg_el = ET.fromstring(f'<svg xmlns="{NS}">{fg_svg}</svg>')[0]
        root.append(fg_el)

    vx, vy, vw, vh = map(float, root.attrib['viewBox'].split())
    content_boxes = [(vx, vy, vx + vw, vy + vh)] + list(atom_boxes.values()) + extra_boxes
    min_x, min_y, max_x, max_y = _union_boxes(content_boxes)
    pad = 4.0
    final_x = min_x - pad
    final_y = min_y - pad
    final_w = (max_x - min_x) + 2.0 * pad
    final_h = (max_y - min_y) + 2.0 * pad
    root.set('viewBox', f'{final_x:.2f} {final_y:.2f} {final_w:.2f} {final_h:.2f}')
    root.set('width', f'{final_w:.2f}px')
    root.set('height', f'{final_h:.2f}px')
    return ET.tostring(root, encoding='unicode'), []


def decorate_depiction(depiction: Any, mol: Chem.Mol, annotations: list[dict[str, Any]]) -> Any:
    """Attach annotations to a codex_organic_chem MoleculeDepiction, expanding its bounds cleanly."""
    if not annotations:
        return depiction
    root = ET.fromstring(f'<svg xmlns="{NS}">{depiction.svg_body}</svg>')
    atom_boxes = extract_atom_boxes_from_svg(root, depiction.atom_points, depiction.atom_label_boxes)
    bg_svg, fg_svg, extra_boxes, extra_text_boxes = render_annotations_overlay(
        mol, depiction.atom_points, atom_boxes, annotations, caption=''
    )
    if not extra_boxes:
        return depiction

    base_ink = depiction.ink_box or (0.0, 0.0, float(depiction.width), float(depiction.height))
    min_x, min_y, max_x, max_y = _union_boxes([base_ink, *extra_boxes])
    pad = 3.0
    dx = min_x - pad
    dy = min_y - pad
    new_w = max(8, int(math.ceil((max_x - min_x) + 2.0 * pad)))
    new_h = max(8, int(math.ceil((max_y - min_y) + 2.0 * pad)))

    combined = '\n'.join(part for part in (bg_svg, depiction.svg_body, fg_svg) if part)
    if abs(dx) > 1e-3 or abs(dy) > 1e-3:
        combined = f'<g transform="translate({-dx:.2f},{-dy:.2f})">\n{combined}\n</g>'

    from codex_organic_chem.figure_style import MoleculeDepiction

    return MoleculeDepiction(
        svg_body=combined,
        width=new_w,
        height=new_h,
        bond_lengths_px=depiction.bond_lengths_px,
        atom_points=[(x - dx, y - dy) for x, y in depiction.atom_points],
        label_boxes=[(a - dx, b - dy, c - dx, d - dy) for a, b, c, d in (*depiction.label_boxes, *extra_text_boxes)],
        atom_label_boxes={
            idx: [(a - dx, b - dy, c - dx, d - dy) for a, b, c, d in boxes]
            for idx, boxes in depiction.atom_label_boxes.items()
        },
        ink_box=(min_x - dx, min_y - dy, max_x - dx, max_y - dy),
        warnings=depiction.warnings,
    )
