import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-practice-mgmt-'));
try {
  const course = { id: 'course-practice', name: '有机化学' };
  const store = new LearningStore({ root });
  await store.initCourse(course);

  const spec = {
    title: '第一周随堂测验',
    items: [
      { id: 'q1', type: 'choice', prompt: '甲烷的杂化方式是？', options: [{ id: 'a', text: 'sp3' }, { id: 'b', text: 'sp2' }], answer: 'a' },
      { id: 'q2', type: 'true_false', prompt: '乙烯分子中所有原子共面。', answer: true },
      { id: 'q3', type: 'fill_blank', prompt: '苯环上的典型反应是____取代反应。', answer: '亲电', acceptedAnswers: ['亲电取代'] },
      { id: 'q4', type: 'short_answer', prompt: '解释 SN2 反应的立体化学特征。', answer: '构型翻转', rubric: '需提及背面进攻与 Walden 翻转' },
      { id: 'q5', type: 'flashcard', prompt: 'Markovnikov 规则', answer: '氢加到含氢较多的双键碳上' },
    ],
  };

  const reg = await store.registerSet(course, { threadId: 't1', itemId: 'm1', spec });
  assert.equal(reg.items.length, 5);
  const [q1, q2, q3, q4, q5] = reg.items;

  // Check stats questionCount
  const stats1 = await store.courseStats(course);
  assert.equal(stats1.questionCount, 5);

  // Create categories
  const c1 = await store.createPracticeCategory(course, { unit: '第一单元 分子结构', knowledgePoint: '杂化轨道' });
  assert.equal(c1.category.unit, '第一单元 分子结构');
  assert.equal(c1.categories.length, 1);

  // Duplicate category is idempotent
  const c1Dup = await store.createPracticeCategory(course, { unit: '第一单元 分子结构', knowledgePoint: '杂化轨道' });
  assert.equal(c1Dup.categories.length, 1);

  // Reject empty category
  await assert.rejects(() => store.createPracticeCategory(course, { unit: '  ', knowledgePoint: '' }));

  // Manual categorization
  const catRes = await store.categorizeQuestions(course, {
    questionIds: [q1.id, q2.id],
    unit: '第一单元 分子结构',
    knowledgePoint: '杂化轨道',
  });
  assert.equal(catRes.updatedCount, 2);

  // AI batch organization
  const orgRes = await store.applyPracticeOrganization(course, [
    { questionId: q3.id, unit: '第三单元 芳香烃', knowledgePoint: '亲电芳香取代' },
    { questionId: q4.id, unit: '第四单元 卤代烃', knowledgePoint: 'SN2 机理' },
    { questionId: q5.id, unit: '第二单元 烯烃', knowledgePoint: '加成规则' },
  ]);
  assert.equal(orgRes.organizedCount, 3);

  let data = await store.learning(course);
  const foundQ1 = data.items.find(i => i.id === q1.id);
  const foundQ3 = data.items.find(i => i.id === q3.id);
  assert.equal(foundQ1.unit, '第一单元 分子结构');
  assert.equal(foundQ1.organizedBy, 'user');
  assert.equal(foundQ3.unit, '第三单元 芳香烃');
  assert.equal(foundQ3.organizedBy, 'ai');
  assert.equal(data.categories.length, 4);

  // Re-registering the same chat set after AI organization must NOT throw conflict and must preserve categories!
  const regAgain = await store.registerSet(course, { threadId: 't1', itemId: 'm1', spec });
  assert.equal(regAgain.items.length, 5);
  assert.equal(regAgain.items.find(i => i.id === q3.id).unit, '第三单元 芳香烃');

  // Rename category updates both category registry and tagged questions
  const ren = await store.renamePracticeCategory(course, {
    oldUnit: '第一单元 分子结构',
    oldKnowledgePoint: '杂化轨道',
    unit: 'Unit 1 Structure',
    knowledgePoint: 'Hybridization',
  });
  assert.equal(ren.updatedQuestions, 2);
  data = await store.learning(course);
  assert.equal(data.items.find(i => i.id === q1.id).unit, 'Unit 1 Structure');
  assert.equal(data.items.find(i => i.id === q2.id).knowledgePoint, 'Hybridization');

  // Delete category preserves questions and clears their unit/knowledgePoint
  const delCat = await store.deletePracticeCategory(course, {
    unit: 'Unit 1 Structure',
    knowledgePoint: 'Hybridization',
  });
  assert.equal(delCat.clearedQuestions, 2);
  data = await store.learning(course);
  assert.equal(data.items.length, 5);
  assert.equal(data.items.find(i => i.id === q1.id).unit, undefined);
  assert.equal(data.items.find(i => i.id === q1.id).knowledgePoint, undefined);

  // Edit questions (choice, true_false, fill_blank, short_answer, flashcard)
  const updChoice = await store.updateQuestion(course, {
    questionId: q1.id,
    prompt: '甲烷中心碳原子的杂化轨道类型是？',
    options: [{ id: 'a', text: 'sp3 杂化' }, { id: 'b', text: 'sp2 杂化' }],
    multiple: false,
    answer: 'a',
    explanation: '四个等同的 C-H 单键构成正四面体。',
    unit: '第一单元 烷烃',
    knowledgePoint: '碳原子杂化',
  });
  assert.equal(updChoice.item.prompt, '甲烷中心碳原子的杂化轨道类型是？');
  assert.equal(updChoice.item.unit, '第一单元 烷烃');

  // Invalid choice update rejected
  await assert.rejects(() =>
    store.updateQuestion(course, {
      questionId: q1.id,
      answer: 'nonexistent',
    })
  );

  // Edit true_false
  const updTf = await store.updateQuestion(course, { questionId: q2.id, answer: false, explanation: 'Updated' });
  assert.equal(updTf.item.answer, false);

  // Edit fill_blank
  const updFill = await store.updateQuestion(course, {
    questionId: q3.id,
    answer: '亲电取代',
    acceptedAnswers: ['亲电'],
  });
  assert.deepEqual(updFill.item.acceptedAnswers, ['亲电']);

  // Submit attempt on q4 then delete q4 -> attempt removed and re-register does NOT resurrect q4
  await store.submitAttempt(course, { questionId: q4.id, answer: '背面进攻导致构型翻转' });
  const delQ = await store.deleteQuestions(course, [q4.id]);
  assert.deepEqual(delQ.deletedIds, [q4.id]);
  data = await store.learning(course);
  assert.equal(data.items.length, 4);
  assert.equal(data.attempts.filter(a => a.questionId === q4.id).length, 0);

  // Re-registering original spec must NOT resurrect deleted q4 or overwrite edited q1!
  const regPostDelete = await store.registerSet(course, { threadId: 't1', itemId: 'm1', spec });
  assert.equal(regPostDelete.items.length, 4);
  assert(!regPostDelete.items.some(i => i.id === q4.id));
  assert.equal(regPostDelete.items.find(i => i.id === q1.id).prompt, '甲烷中心碳原子的杂化轨道类型是？');

  // Verify courseStats reflects deletion
  const stats2 = await store.courseStats(course);
  assert.equal(stats2.questionCount, 4);

  console.log('Practice Management: categories CRUD, AI/manual organization, question editing, deletion, non-resurrection, and stats passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
