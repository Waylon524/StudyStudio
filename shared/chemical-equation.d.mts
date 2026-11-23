export type EquationArrowKind = 'forward' | 'equilibrium' | 'reverse';
export type EquationRouteItem =
  | {type: 'text'; text: string}
  | {type: 'plus'}
  | {type: 'arrow'; arrow_kind: EquationArrowKind; label: string; sublabel: string};
export type EquationRouteSpec = {rows: {items: EquationRouteItem[]}[]};
export class ChemicalEquationError extends Error {
  code: string;
  offset?: number;
  constructor(code: string, message: string, offset?: number);
}
export function extractCeExpression(source: string): string | null;
export function chemicalEquationFromMath(source: string): {kind: 'equation'; source: string} | null;
export function formatChemicalSpecies(source: string): string;
export function formatChemicalCondition(source: string): string;
export function parseChemicalEquation(source: string): EquationRouteSpec;
export function parseChemicalFormula(source: string): EquationRouteSpec;
