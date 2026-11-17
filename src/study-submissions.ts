type SubmissionState = {
  pending: Set<Promise<unknown>>
  failures: Map<string, unknown>
  latest: Map<string, symbol>
}
const submissions = new Map<string, SubmissionState>()
function clean(courseId:string,state:SubmissionState) {
  if(!state.pending.size&&!state.failures.size&&submissions.get(courseId)===state)submissions.delete(courseId)
}

// Shared by inline questions and the learning sidebar, including unmounted cards.
export function trackStudySubmission<T>(courseId:string,questionId:string,request:Promise<T>):Promise<T> {
  let state=submissions.get(courseId)
  if(!state){state={pending:new Set(),failures:new Map(),latest:new Map()};submissions.set(courseId,state)}
  const current=state,token=Symbol(questionId)
  current.latest.set(questionId,token);current.failures.delete(questionId);current.pending.add(request)
  void request.then(()=>{
    current.pending.delete(request)
    if(current.latest.get(questionId)===token){current.latest.delete(questionId);current.failures.delete(questionId)}
    clean(courseId,current)
  },error=>{
    current.pending.delete(request)
    if(current.latest.get(questionId)===token){current.latest.delete(questionId);current.failures.set(questionId,error)}
  })
  return request
}

export async function waitForStudySubmissions(courseId:string):Promise<void> {
  for(;;){
    const state=submissions.get(courseId)
    if(!state)return
    if(state.pending.size){await Promise.allSettled([...state.pending]);continue}
    // Report a failed save once rather than permanently locking the conversation.
    const failed=state.failures.size>0
    state.failures.clear();clean(courseId,state)
    if(failed)throw Error('刚才的作答未能保存，消息尚未发送。请在题目中重试后再发送。')
    return
  }
}
