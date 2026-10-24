/** 自测题质量启发式:只标记“答案过短、缺少原因”的题,不判断知识正确性。 */
export function flagQuiz(qa) {
  const q = String(qa?.q || '').replace(/\s+/g, '');
  const a = String(qa?.a || '').replace(/\s+/g, '');
  if (!q || !a) return 'answer-too-short';
  if (/^(是|不是|对|不对|会|不会|能|不能|可以|不可以)[。；;]?$/.test(a)) return 'yes-no-short';
  if (a.length < 8) return 'answer-too-short';
  if (/吗？$/.test(q) && a.length < 25) return 'yes-no-short';
  if (/是什么|为什么|有什么用|做什么|怎么回事/.test(q) && a.length < 15) return 'what-short';
  return null;
}

export function auditQuizzes(pages) {
  const flagged = [];
  const byBranch = {};
  let total = 0;
  for (const page of pages) {
    for (const qa of page.qa || []) {
      total++;
      const reason = flagQuiz(qa);
      if (!reason) continue;
      flagged.push({ path: page.path, q: qa.q, a: qa.a, reason });
      const branch = String(page.path).split('/')[0];
      byBranch[branch] = (byBranch[branch] || 0) + 1;
    }
  }
  return { total, flagged, byBranch };
}
