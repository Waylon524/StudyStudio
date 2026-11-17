export const QUESTION_TYPES = ['true_false', 'choice', 'fill_blank', 'short_answer', 'flashcard'];

export function validateStudySpec(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.items) || !spec.items.length || spec.items.length > 100) throw new Error('学习内容必须包含 1–100 个题目。');
  const seen = new Set();
  for (const [i, q] of spec.items.entries()) {
    if (!q || !QUESTION_TYPES.includes(q.type) || typeof q.prompt !== 'string' || !q.prompt.trim() || q.prompt.length > 5000) throw new Error(`第 ${i + 1} 题类型或题干无效。`);
    if (q.id !== undefined && (typeof q.id !== 'string' || !q.id.trim() || q.id.length > 200)) throw new Error('题目 ID 无效。');
    const id = q.id ?? String(i + 1); if (seen.has(id)) throw new Error('题目 ID 重复。'); seen.add(id);
    if (q.type === 'true_false' && typeof q.answer !== 'boolean') throw new Error('判断题答案必须是布尔值。');
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 30 || q.options.some(o => !o || typeof o.id !== 'string' || !o.id || typeof o.text !== 'string') || new Set(q.options.map(o => o.id)).size !== q.options.length) throw new Error('选择题选项无效。');
      const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
      if (!answers.length || answers.some(a => typeof a !== 'string' || !q.options.some(o => o.id === a)) || (!q.multiple && answers.length !== 1)) throw new Error('选择题答案必须引用有效选项 ID。');
    }
    if (q.type === 'fill_blank' && !((typeof q.answer === 'string' && q.answer.trim()) || (Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.some(a => typeof a === 'string' && a.trim())))) throw new Error('填空题需要标准答案。');
  }
  return spec;
}

export function gradeAnswer(q, answer) {
  if (q.type === 'true_false') return typeof answer === 'boolean' ? {status:'graded', correct:answer === q.answer} : {status:'invalid'};
  if (q.type === 'choice') {
    const a = Array.isArray(answer) ? answer : [answer], expected = Array.isArray(q.answer) ? q.answer : [q.answer];
    if (!a.length || a.some(x => typeof x !== 'string' || !q.options.some(o => o.id === x)) || new Set(a).size !== a.length || (!q.multiple && a.length !== 1)) return {status:'invalid'};
    return {status:'graded', correct: a.length === expected.length && a.every(x => expected.includes(x))};
  }
  if (q.type === 'fill_blank') {
    if (typeof answer !== 'string' || !answer.trim()) return {status:'invalid'};
    const normalize = x => x.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const expected = [...(typeof q.answer === 'string' ? [q.answer] : []), ...(q.acceptedAnswers || [])].filter(x => typeof x === 'string');
    return {status:'graded', correct:expected.some(x => normalize(x) === normalize(answer))};
  }
  if (q.type === 'short_answer') return typeof answer === 'string' && answer.trim() ? {status:'pending_feedback',correct:null} : {status:'invalid'};
  if (q.type === 'flashcard') return ['again','hard','good','easy'].includes(answer) ? {status:'self_assessed',correct:null} : {status:'invalid'};
  return {status:'invalid'};
}
