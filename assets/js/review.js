/* 每日复习页:只负责抽题、展开答案和记录“会/不会”，不涉及后端。 */
(() => {
  const KEY = 'dos2unix-review-v1';
  const COUNT = 5;
  const list = document.getElementById('review-list');
  const empty = document.getElementById('review-empty');
  const progress = document.getElementById('review-progress');
  const newBtn = document.getElementById('review-new');
  const resetBtn = document.getElementById('review-reset');
  if (!list) return;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch {
      return {};
    }
  };
  const save = (data) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* 隐私模式或存储被禁用时静默失败,页面仍可正常抽题 */
    }
  };

  const state = load();
  let allQuestions = [];

  function rank(q) {
    const s = state[q.id];
    if (!s) return 0;
    return s.correct === false ? 1 : 2;
  }

  function pick(n) {
    const pool = [...allQuestions].sort(
      (a, b) => rank(a) - rank(b) || Math.random() - 0.5
    );
    const seen = new Set();
    const out = [];
    for (const q of pool) {
      if (out.length >= n) break;
      if (seen.has(q.id)) continue;
      seen.add(q.id);
      out.push(q);
    }
    return out.sort(() => Math.random() - 0.5);
  }

  function updateProgress() {
    if (!progress) return;
    const total = Object.keys(state).length;
    const wrong = Object.values(state).filter((s) => s.correct === false).length;
    progress.textContent = total ? `已记录 ${total} 题 · 错题 ${wrong} 题` : '';
  }

  function card(q, index) {
    const li = document.createElement('li');
    li.className = 'review-card';

    const meta = document.createElement('p');
    meta.className = 'review-meta';
    const link = document.createElement('a');
    link.href = q.p;
    link.textContent = q.d || q.n;
    meta.append(link);

    const question = document.createElement('p');
    question.className = 'review-question';
    question.textContent = `${index + 1}. ${q.q}`;

    const actions = document.createElement('div');
    actions.className = 'review-card-actions';

    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'review-btn';
    show.textContent = '显示答案';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'review-btn ok';
    ok.textContent = '会';

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'review-btn no';
    no.textContent = '不会';

    const answer = document.createElement('p');
    answer.className = 'review-answer';
    answer.hidden = true;
    answer.textContent = q.a;

    const mark = (correct) => {
      const s = state[q.id] || {};
      state[q.id] = { ...s, correct, last: Date.now() };
      save(state);
      ok.classList.toggle('is-active', correct === true);
      no.classList.toggle('is-active', correct === false);
      if (correct === true) {
        answer.hidden = false;
        show.textContent = '收起答案';
      }
      updateProgress();
    };

    const existing = state[q.id];
    if (existing) {
      ok.classList.toggle('is-active', existing.correct === true);
      no.classList.toggle('is-active', existing.correct === false);
    }

    show.addEventListener('click', () => {
      answer.hidden = !answer.hidden;
      show.textContent = answer.hidden ? '显示答案' : '收起答案';
    });
    ok.addEventListener('click', () => mark(true));
    no.addEventListener('click', () => mark(false));

    actions.append(show, ok, no);
    li.append(meta, question, actions, answer);
    return li;
  }

  function render() {
    if (!allQuestions.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.replaceChildren();
    pick(COUNT).forEach((q, i) => list.append(card(q, i)));
    updateProgress();
  }

  fetch('js/questions.json', { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('questions.json');
      return r.json();
    })
    .then((data) => {
      allQuestions = Array.isArray(data) ? data : [];
      render();
    })
    .catch(() => {
      empty.hidden = false;
    });

  newBtn?.addEventListener('click', render);
  resetBtn?.addEventListener('click', () => {
    if (!confirm('清空本地复习记录？')) return;
    for (const k of Object.keys(state)) delete state[k];
    save(state);
    render();
  });
})();
