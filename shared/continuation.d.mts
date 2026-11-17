export const CONTINUE_INPUT:string;
export function isContinuationMessage(item:any,action?:string):boolean;
export function hideContinuationInputs<T>(turns:T[],actions?:Record<string,string>):T[];
