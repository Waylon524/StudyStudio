"""Exact, graph-matched reagent abbreviations; all other graphs stay structural."""
from rdkit import Chem


def canonical(mol):
    return Chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)


def molecule(smiles):
    options = Chem.SmilesParserParams()
    options.removeHs = False
    options.parseName = False
    return Chem.MolFromSmiles(smiles, options)


# Formula labels are deliberately an allowlist, never a molecular-formula
# fallback: distinct organic isomers must retain their connectivity in the SVG.
_FORMULAS = {
    'O': 'H₂O', '[H][H]': 'H₂', 'O=O': 'O₂', '[O-][O+]=O': 'O₃',
    'OO': 'H₂O₂', 'N': 'NH₃', 'Cl': 'HCl', 'Br': 'HBr', 'I': 'HI',
    'FF': 'F₂', 'ClCl': 'Cl₂', 'BrBr': 'Br₂', 'II': 'I₂',
    '[OH-]': 'OH⁻', '[H+]': 'H⁺', '[Na+]': 'Na⁺', '[K+]': 'K⁺',
    '[Li+]': 'Li⁺', '[Cl-]': 'Cl⁻', '[Br-]': 'Br⁻', '[I-]': 'I⁻',
    '[O-][Mn](=O)(=O)=O': 'MnO₄⁻', 'O=S(=O)(O)O': 'H₂SO₄',
    'OP(=O)(O)O': 'H₃PO₄', '[O-][N+](=O)O': 'HNO₃',
}
_FORMULAS = {canonical(molecule(source)): label for source, label in _FORMULAS.items()}
_SALTS = [
    (('[K+]', '[O-][Mn](=O)(=O)=O'), 'KMnO₄'),
    (('[Na+]', '[O-][Mn](=O)(=O)=O'), 'NaMnO₄'),
    (('[Na+]', '[OH-]'), 'NaOH'), (('[K+]', '[OH-]'), 'KOH'),
    (('[Li+]', '[OH-]'), 'LiOH'), (('[Na+]', '[BH4-]'), 'NaBH₄'),
    (('[Li+]', '[AlH4-]'), 'LiAlH₄'),
]
_SALTS = [(tuple(canonical(molecule(source)) for source in sources), label)
          for sources, label in _SALTS]


def reagent_parts(source):
    """Return display parts for a SMILES mixture, or None for legacy prose."""
    if not isinstance(source, str):
        raise ValueError('试剂 SMILES 必须是字符串。')
    source = source.strip()
    if not source:
        return []
    if any(char.isspace() for char in source):
        return None
    mol = molecule(source)
    if mol is None:
        return None
    fragments = list(Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=True))
    entries = []
    for fragment in fragments:
        key = canonical(fragment)
        # Isotopic or atom-mapped inputs remain drawings, preserving annotations.
        exact = not any(atom.GetIsotope() or atom.GetAtomMapNum() for atom in fragment.GetAtoms())
        entries.append({'key': key, 'exact': exact, 'smiles': key})
    replacements, consumed = {}, set()
    for sources, label in _SALTS:
        while True:
            chosen = []
            for key in sources:
                index = next((i for i, entry in enumerate(entries)
                              if i not in consumed and i not in chosen
                              and entry['exact'] and entry['key'] == key), None)
                if index is None:
                    break
                chosen.append(index)
            if len(chosen) != len(sources):
                break
            consumed.update(chosen)
            replacements[min(chosen)] = {'text': label}
    parts = []
    for index, entry in enumerate(entries):
        if index in replacements:
            parts.append(replacements[index])
        elif index not in consumed:
            formula = _FORMULAS.get(entry['key']) if entry['exact'] else None
            parts.append({'text': formula} if formula else {'smiles': entry['smiles']})
    return parts
