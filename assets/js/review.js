/* 每日复习页:抽题、按分支筛选、错题优先、连续答对两次移出随机池。 */
(() => {
  const KEY = 'dos2unix-review-v1';
  const COUNT = 5;
  const MASTER_STREAK = 2;

  const page = document.querySelector('.review-page');
  const questionsUrl = page?.dataset.questions || 'js/questions.json';
  const list = document.getElementById('review-list');
  const daily = document.getElementById('review-daily');
  const empty = document.getElementById('review-empty');
  const progress = document.getElementById('review-progress');
  const progressFill = document.getElementById('review-progress-fill');
  const branchSelect = document.getElementById('review-branch');
  const wrongOnly = document.getElementById('review-wrong-only');
  const newBtn = document.getElementById('review-new');
  const resetBtn = document.getElementById('review-reset');
  if (!list) return;

  const normalize = (raw) => {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, s] of Object.entries(raw)) {
      if (!s || typeof s !== 'object') continue;
      const correct = s.correct === true ? true : s.correct === false ? false : undefined;
      out[id] = {
        correct,
        streak: Number.isFinite(s.streak) ? Math.max(0, s.streak) : 0,
        last: Number.isFinite(s.last) ? s.last : 0,
      };
    }
    return out;
  };

  const load = () => {
    try {
      return normalize(JSON.parse(localStorage.getItem(KEY) || '{}'));
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

  const branch = () => (branchSelect ? branchSelect.value : '');
  const onlyWrong = () => Boolean(wrongOnly && wrongOnly.checked);
  const inBranch = (q) => !branch() || q.b === branch();
  const isWrong = (q) => state[q.id] && state[q.id].correct === false;
  const isMastered = (q) =>
    state[q.id] && state[q.id].correct === true && (state[q.id].streak || 0) >= MASTER_STREAK;

  function rank(q) {
    const s = state[q.id];
    if (!s || s.correct === undefined) return 1;
    if (s.correct === false) return 0;
    if ((s.streak || 0) >= MASTER_STREAK) return 3;
    return 2;
  }

  function scope() {
    return allQuestions.filter(inBranch);
  }

  function pool() {
    let out = scope();
    if (onlyWrong()) out = out.filter(isWrong);
    return out;
  }

  function pick(n, exclude = new Set()) {
    const shuffled = pool()
      .filter((q) => !exclude.has(q.id))
      .sort(() => Math.random() - 0.5);
    // 稳定排序:同优先级内保留随机顺序,错题在最前,已掌握在最末。
    shuffled.sort((a, b) => rank(a) - rank(b));
    // 先尽量保证每页只出现一题,不够再补同页的其它题。
    const out = [];
    const ids = new Set();
    const pages = new Set();
    for (const q of shuffled) {
      if (out.length >= n) break;
      if (ids.has(q.id) || pages.has(q.p)) continue;
      ids.add(q.id);
      pages.add(q.p);
      out.push(q);
    }
    for (const q of shuffled) {
      if (out.length >= n) break;
      if (ids.has(q.id)) continue;
      ids.add(q.id);
      out.push(q);
    }
    return out.sort(() => Math.random() - 0.5);
  }

  function localDateKey(d = new Date()) {
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function dailyQuestion() {
    const dateKey = localDateKey();
    const source = pool();
    if (!source.length) return null;
    return { q: source[hash(dateKey) % source.length], dateKey };
  }

  function updateProgress() {
    const p = scope();
    const recorded = p.filter((q) => state[q.id] && state[q.id].correct !== undefined).length;
    const wrong = p.filter(isWrong).length;
    const mastered = p.filter(isMastered).length;
    const name = branch()
      ? branchSelect.options[branchSelect.selectedIndex]?.textContent || branch()
      : '全部分支';
    if (progress) {
      progress.textContent = `${name}：已记录 ${recorded}/${p.length} · 错题 ${wrong} · 已掌握 ${mastered}`;
    }
    if (progressFill) {
      progressFill.style.width = p.length ? `${(mastered / p.length) * 100}%` : '0%';
    }
  }

  function card(q, index, opts = {}) {
    const li = document.createElement('li');
    li.className = 'review-card';
    if (isMastered(q)) li.classList.add('is-mastered');

    const meta = document.createElement('p');
    meta.className = 'review-meta';
    const link = document.createElement('a');
    link.href = q.p;
    link.textContent = q.d || q.n;
    const branchTag = document.createElement('span');
    branchTag.className = 'review-branch-tag';
    branchTag.textContent = q.bn || q.b || '';
    meta.append(branchTag, link);

    const question = document.createElement('p');
    question.className = 'review-question';
    question.textContent = opts.numbered === false ? q.q : `${index + 1}. ${q.q}`;

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

    const status = document.createElement('span');
    status.className = 'review-status';

    const answer = document.createElement('p');
    answer.className = 'review-answer';
    answer.hidden = true;
    answer.textContent = q.a;

    const paint = () => {
      const s = state[q.id];
      ok.classList.toggle('is-active', Boolean(s && s.correct === true));
      no.classList.toggle('is-active', Boolean(s && s.correct === false));
      li.classList.toggle('is-mastered', isMastered(q));
      if (!s || s.correct === undefined) {
        status.textContent = '';
      } else if (s.correct === false) {
        status.textContent = '错题 · 会优先出现';
      } else if ((s.streak || 0) >= MASTER_STREAK) {
        status.textContent = '已掌握 · 连续答对两次';
      } else {
        status.textContent = '连续答对 1 次 · 再答对一次移出随机池';
      }
    };

    const mark = (correct) => {
      const prev = state[q.id] || {};
      const streak = correct ? (prev.streak || 0) + 1 : 0;
      state[q.id] = { correct, streak, last: Date.now() };
      save(state);
      paint();
      if (correct) {
        answer.hidden = false;
        show.textContent = '收起答案';
      }
      updateProgress();
    };

    paint();

    show.addEventListener('click', () => {
      answer.hidden = !answer.hidden;
      show.textContent = answer.hidden ? '显示答案' : '收起答案';
    });
    ok.addEventListener('click', () => mark(true));
    no.addEventListener('click', () => mark(false));

    actions.append(show, ok, no, status);
    li.append(meta, question, actions, answer);
    return li;
  }

  function renderDaily(d) {
    if (!daily) return;
    daily.replaceChildren();
    if (!d) {
      daily.hidden = true;
      return;
    }
    daily.hidden = false;
    const head = document.createElement('div');
    head.className = 'review-daily-head';
    const title = document.createElement('p');
    title.className = 'review-daily-title';
    title.id = 'review-daily-title';
    title.textContent = '今日一题';
    const date = document.createElement('span');
    date.className = 'review-daily-date';
    date.textContent = d.dateKey;
    head.append(title, date);
    daily.append(head, card(d.q, 0, { numbered: false }));
  }

  function render() {
    if (!allQuestions.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const d = dailyQuestion();
    renderDaily(d);
    const picked = pick(COUNT, new Set(d ? [d.q.id] : []));
    list.replaceChildren();
    if (!picked.length) {
      const li = document.createElement('li');
      li.className = 'review-empty';
      li.textContent = onlyWrong()
        ? '当前筛选下没有更多错题。取消“只练错题”后再抽题。'
        : '当前筛选下没有可抽取的题目。';
      list.append(li);
    } else {
      picked.forEach((q, i) => list.append(card(q, i)));
    }
    updateProgress();
  }

  fetch(questionsUrl)
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
  branchSelect?.addEventListener('change', render);
  wrongOnly?.addEventListener('change', render);
  resetBtn?.addEventListener('click', () => {
    if (!confirm('清空本地复习记录？')) return;
    for (const k of Object.keys(state)) delete state[k];
    save(state);
    render();
  });
})();
