import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTasks,
  normalizeTask,
  clearTask,
  pendingSummary,
  taskUrl,
} from '../extension/mooc-tasks.mjs';
const course = 'https://www.icourse163.org/learn/example';
test('旧记录的尾部引号归一化，按课程和任务去重', () => {
  const result = mergeTasks([
    { course, key: 'unit:1"', title: '讨论' },
    { course, key: 'unit:1', title: '讨论' },
    { course: course + '2', key: 'unit:1', title: '另一门课' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].key, 'unit:1');
});
test('元数据增补保留已有原因和入口', () => {
  const old = normalizeTask(
    {
      key: 'lesson:测验',
      title: '测验',
      reason: '需要本人独立完成声明',
      url: course + '#/learn/quiz?id=1',
    },
    course
  );
  const rows = mergeTasks([old], { key: old.key, title: '测验', chapter: '第一章' }, course);
  assert.equal(rows[0].reason, old.reason);
  assert.equal(rows[0].url, old.url);
  assert.equal(rows[0].chapter, '第一章');
});
test('三个测验和三个讨论分开说明原因', () => {
  const tasks = mergeTasks(
    Array.from({ length: 6 }, (_, i) => ({
      course,
      key: i < 3 ? 'lesson:测验' + i : 'unit:' + i,
      title: '待处理',
    }))
  );
  assert.equal(pendingSummary(tasks), '3项测验需要本人确认，3项讨论需要本人参与');
});
test('入口只允许同课程的对应测验或单元，排除账号及外部链接', () => {
  assert.equal(
    taskUrl(course, course + '#/learn/quiz?id=1', 'lesson:测验'),
    course + '#/learn/quiz?id=1'
  );
  for (const value of [
    'https://other.test/learn/example#/learn/quiz?id=1',
    course + '2#/learn/quiz?id=1',
    course + '#/learn/exam?id=1',
    course + '?token=private#/learn/quiz?id=1',
  ])
    assert.equal(taskUrl(course, value, 'lesson:测验'), '');
  assert.equal(taskUrl(course, course + '#/learn/content?id=1&cid=2', 'unit:1'), '');
});
test('草稿或已浏览不清除任何待办', () => {
  const tasks = [
    { course, key: 'lesson:测验' },
    { course, key: 'unit:1' },
  ];
  for (const proof of ['draft-only', 'learned', 'viewed', ''])
    assert.deepEqual(clearTask(tasks, course, 'lesson:测验', proof), tasks);
});
test('完成证据仅清除对应课程与对应类型', () => {
  const tasks = [
    { course, key: 'lesson:测验' },
    { course: course + '2', key: 'lesson:测验' },
    { course, key: 'unit:1' },
  ];
  assert.equal(clearTask(tasks, course, 'lesson:测验', 'discussion-own-post').length, 3);
  const after = clearTask(tasks, course, 'lesson:测验', 'quiz-submitted');
  assert.equal(after.length, 2);
  assert.equal(after[0].course, course + '2');
});
test('本人回复证据清除本人参与待办，不清除测验', () => {
  const tasks = [
    { course, key: 'unit:1' },
    { course, key: 'lesson:测验' },
  ];
  assert.deepEqual(clearTask(tasks, course, 'unit:1', 'discussion-own-post'), [tasks[1]]);
});
