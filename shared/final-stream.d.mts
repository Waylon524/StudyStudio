export type FinalStreamItem={id:string;type:'agentMessage';text:string;phase:string|null;completed:boolean};
export type FinalStreamState={turnId:string|null;items:Map<string,FinalStreamItem>;finished:boolean;success:boolean};
export type FinalStreamMessage={id:string;role:'assistant';text:string;streaming:boolean;incomplete:boolean};
export function createFinalStream():FinalStreamState;
export function applyFinalStream(state:FinalStreamState,method:string,params?:any):boolean;
export function finishFinalStream(state:FinalStreamState,options?:{success?:boolean;items?:any[]}):void;
export function finalStreamMessages(state:FinalStreamState):FinalStreamMessage[];
