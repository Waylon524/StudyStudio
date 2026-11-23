import json
import sys
from copy import deepcopy

from codex_organic_chem.service import chem_mechanism_render, chem_mechanism_validate, chem_route_figure
from chem_annotations import render_standalone_molecule_svg
from chem_style import install, mechanism_style
from chem_reagents import reagent_parts

install()


def main():
    data = json.load(sys.stdin)
    kind, source = data['kind'], data['source']
    if kind == 'molecule':
        if isinstance(source, str):
            if not source.strip() or '>' in source:
                raise ValueError('Molecule requires one SMILES string.')
        elif isinstance(source, dict):
            if not isinstance(source.get('smiles'), str) or not source['smiles'].strip() or '>' in source['smiles']:
                raise ValueError('Molecule specification requires a valid SMILES string.')
        else:
            raise ValueError('Molecule requires a SMILES string or a molecule specification object.')
        svg, warnings = render_standalone_molecule_svg(source)
        return {'status': 'ok', 'svg': svg, 'warnings': warnings}
    if kind == 'reaction':
        if isinstance(source, str):
            if source.count('>') != 2:
                raise ValueError('Reaction requires reaction SMILES or a route specification.')
            left, reagents, right = source.split('>')
            if not left or not right or any(not part for part in left.split('.') + right.split('.')):
                raise ValueError('Reaction requires nonempty reactants and products, separated by dots.')
            # Preserve reactant/product graphs and parse reagent graphs separately.
            # Legacy temperature/catalyst prose remains an ordinary arrow label.
            if any(c in reagents for c in '\n\r<>'):
                raise ValueError('Unsupported reaction reagent annotation.')
            def molecules(text):
                result = []
                for smiles in text.split('.'):
                    if result: result.append({'type': 'plus'})
                    result.append({'smiles': smiles})
                return result
            arrow = {'type': 'arrow'}
            if reagents:
                parts = reagent_parts(reagents)
                if parts is not None:
                    arrow['reagent_smiles'] = reagents
                elif any(char in reagents for char in '[]@'):
                    raise ValueError('无法识别箭头上的试剂结构，请使用有效 SMILES 或普通条件文字。')
                else:
                    arrow['label'] = reagents
            source = {'rows': [{'items': molecules(left) + [arrow] + molecules(right)}]}
        if not isinstance(source, dict) or not isinstance(source.get('rows'), list):
            raise ValueError('Reaction route requires a specification with rows.')
        result = chem_route_figure(spec=source, formats=['svg'])
        return {'status': result['status'], 'svg': result.get('svg'), 'warnings': result.get('warnings', []), 'audit': result.get('publication_checks')}
    if kind == 'mechanism':
        if not isinstance(source, dict) or source.get('spec_version') != '2.1':
            raise ValueError('Mechanism requires a MechanismSpec 2.1 object.')
        source = deepcopy(source)
        source.setdefault('layout', {}).setdefault('renderer', 'compact')
        validation = chem_mechanism_validate(source)
        result = chem_mechanism_render(spec=source)
        semantic = validation.get('semantic_checks', {}).get('status')
        status = result.get('status', 'error')
        if semantic != 'valid' or status == 'blocked_for_publication' or validation.get('blocking_issues'):
            status = 'blocked_for_publication'
        return {'status': status, 'svg': mechanism_style(result['svg']) if result.get('svg') else None, 'warnings': list(dict.fromkeys(validation.get('warnings', []) + result.get('warnings', []) + validation.get('blocking_issues', []))), 'validation': validation, 'trace': result.get('mechanism_trace'), 'audit': result.get('publication_checks', {}).get('figure_audit')}
    raise ValueError('Unsupported chemistry kind.')


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'status': 'error', 'svg': None, 'warnings': [str(exc)[:500]]}, ensure_ascii=False))
