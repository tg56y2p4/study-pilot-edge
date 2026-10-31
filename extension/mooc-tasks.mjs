export function taskKey(value) {
  return String(value || '')
    .trim()
    .replace(/["']+$/, '')
    .slice(0, 200);
}
export function taskUrl(course, value, key) {
  try {
    const base = new URL(course),
      url = new URL(value, base),
      route = url.hash.split('?')[0],
      params = new URLSearchParams(url.hash.split('?')[1] || '');
    if (
      url.origin + url.pathname !== base.origin + base.pathname ||
      url.search ||
      url.username ||
      url.password
    )
      return '';
    if (!/^#\/learn\/(?:quiz|content)$/.test(route) || !/^\d+$/.test(params.get('id') || ''))
      return '';
    if (
      key.startsWith('unit:') &&
      (route !== '#/learn/content' || params.get('cid') !== key.slice(5))
    )
      return '';
    if (key.startsWith('lesson:') && route !== '#/learn/quiz') return '';
    return url.href;
  } catch {
    return '';
  }
}
export function normalizeTask(value, course) {
  const key = taskKey(value.key),
    title = String(value.title || '待处理内容')
      .trim()
      .slice(0, 160);
  return {
    course,
    key,
    title,
    kind: key.startsWith('lesson:') ? 'quiz' : 'discussion',
    chapter: String(value.chapter || '')
      .trim()
      .slice(0, 160),
    reason: String(value.reason || '需要本人处理').slice(0, 180),
    url: taskUrl(course, value.url || '', key),
    checkedAt: Number(value.checkedAt) || 0,
  };
}
export function mergeTasks(tasks, patch, course) {
  const output = [],
    seen = new Map();
  for (const row of [...tasks, ...(patch ? [{ ...patch, course }] : [])]) {
    const id = row.course + '|' + taskKey(row.key),
      previous = seen.has(id) ? output[seen.get(id)] : null,
      normalized = normalizeTask({ ...previous, ...row }, row.course);
    if (!normalized.key) continue;
    if (seen.has(id)) {
      Object.assign(previous, normalized);
    } else {
      seen.set(id, output.length);
      output.push(normalized);
    }
  }
  return output;
}
export function pendingSummary(tasks) {
  const quiz = tasks.filter(
      (task) => task.kind === 'quiz' || task.key.startsWith('lesson:')
    ).length,
    discussion = tasks.length - quiz;
  return [
    quiz ? `${quiz}项测验需要本人确认` : '',
    discussion ? `${discussion}项讨论需要本人参与` : '',
  ]
    .filter(Boolean)
    .join('，');
}
export function clearTask(tasks, course, key, proof) {
  key = taskKey(key);
  if (!['quiz-submitted', 'discussion-own-post'].includes(proof)) return tasks;
  return tasks.filter(
    (task) =>
      !(
        task.course === course &&
        taskKey(task.key) === key &&
        (proof === 'quiz-submitted' ? key.startsWith('lesson:') : key.startsWith('unit:'))
      )
  );
}
