/** Lab 实跑状态:构建期校验并给详情页提供徽章数据。 */
export const LAB_STATUS_LABELS = Object.freeze({
  passed: '实跑通过',
  partial: '部分通过',
  'partial-review': '部分验证',
  static: '静态审查',
  new: '新增未跑',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 返回错误列表;空数组表示状态表完整且合法。 */
export function validateLabStatus(data, labSlugs) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['lab-status: 顶层必须是以 slug 为键的对象'];
  }
  const errors = [];
  for (const slug of labSlugs) {
    if (!(slug in data)) errors.push(`lab-status: 缺少 ${slug}`);
  }
  for (const [slug, item] of Object.entries(data)) {
    if (!labSlugs.has(slug)) errors.push(`lab-status: ${slug} 不存在，不是已存在的 Lab`);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`lab-status: ${slug} 的值必须是对象`);
      continue;
    }
    if (!LAB_STATUS_LABELS[item.status]) {
      errors.push(`lab-status: ${slug} 的状态 ${item.status} 无效`);
    }
    if (typeof item.checked !== 'string' || !DATE_RE.test(item.checked)) {
      errors.push(`lab-status: ${slug} 的日期必须是 YYYY-MM-DD`);
    }
    if (typeof item.environment !== 'string' || !item.environment.trim()) {
      errors.push(`lab-status: ${slug} 缺少验证环境`);
    }
    if (item.note != null && typeof item.note !== 'string') {
      errors.push(`lab-status: ${slug} 的 note 必须是字符串`);
    }
  }
  return errors;
}

export function labStatusFor(data, slug) {
  const item = data && data[slug];
  if (!item) return null;
  return { ...item, label: LAB_STATUS_LABELS[item.status] };
}
