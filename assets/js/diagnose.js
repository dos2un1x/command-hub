/* 故障诊断向导:纯前端决策树,不依赖后端。 */
(() => {
  const treesEl = document.getElementById('diagnose-trees');
  const content = document.getElementById('diagnose-content');
  const backBtn = document.getElementById('diagnose-back');
  const resetBtn = document.getElementById('diagnose-reset');
  if (!treesEl || !content) return;

  let trees = [];
  let tree = null;
  let nodeId = null;
  let trail = [];

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* 忽略:复制失败不影响阅读 */
      }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('is-copied');
    }, 1400);
  }

  function renderSidebar() {
    treesEl.replaceChildren();
    for (const t of trees) {
      const btn = el('button', 'diagnose-tree');
      btn.type = 'button';
      btn.dataset.id = t.id;
      btn.classList.toggle('is-active', Boolean(tree && tree.id === t.id));
      if (tree && tree.id === t.id) btn.setAttribute('aria-current', 'true');
      btn.append(el('span', 'diagnose-tree-tag', t.tag), el('span', 'diagnose-tree-title', t.title));
      btn.addEventListener('click', () => selectTree(t.id));
      treesEl.append(btn);
    }
  }

  function updateToolbar() {
    if (backBtn) backBtn.hidden = trail.length === 0;
  }

  function breadcrumb() {
    const nav = el('nav', 'diagnose-crumb');
    nav.setAttribute('aria-label', '当前判断路径');
    nav.append(el('span', 'diagnose-crumb-item', tree.title));
    for (const step of trail) {
      nav.append(el('span', 'diagnose-crumb-sep', '›'));
      nav.append(el('span', 'diagnose-crumb-item', step.choice));
    }
    return nav;
  }

  function commandBlock(command) {
    const wrap = el('div', 'diagnose-command');
    const pre = el('pre');
    const code = el('code', null, command);
    pre.append(code);
    const btn = el('button', 'diagnose-copy', '复制');
    btn.type = 'button';
    btn.addEventListener('click', () => copyText(command, btn));
    wrap.append(pre, btn);
    return wrap;
  }

  function renderQuestion(node) {
    const card = el('article', 'diagnose-card');
    card.append(el('p', 'diagnose-kicker', `第 ${trail.length + 1} 步`));
    if (node.title && node.title !== node.question) {
      card.append(el('p', 'diagnose-subtitle', node.title));
    }
    card.append(el('h2', 'diagnose-question', node.question));
    if (node.hint) card.append(el('p', 'diagnose-hint', node.hint));

    const list = el('div', 'diagnose-options');
    for (const opt of node.options || []) {
      const btn = el('button', 'diagnose-option');
      btn.type = 'button';
      btn.append(el('span', 'diagnose-option-label', opt.label));
      btn.append(el('span', 'diagnose-option-arrow', '→'));
      btn.addEventListener('click', () => {
        trail.push({ id: nodeId, choice: opt.label });
        nodeId = opt.next;
        render();
      });
      list.append(btn);
    }
    card.append(list);
    return card;
  }

  function renderResult(node) {
    const card = el('article', 'diagnose-card diagnose-result');
    card.append(el('p', 'diagnose-kicker', '判断结果'));
    card.append(el('h2', 'diagnose-question', node.title));
    if (node.summary) card.append(el('p', 'diagnose-summary', node.summary));

    if (node.commands && node.commands.length) {
      card.append(el('h3', 'diagnose-section-title', '先跑这些命令'));
      const blocks = el('div', 'diagnose-commands');
      for (const cmd of node.commands) blocks.append(commandBlock(cmd));
      card.append(blocks);
    }

    if (node.links && node.links.length) {
      card.append(el('h3', 'diagnose-section-title', '继续阅读'));
      const links = el('ul', 'diagnose-links');
      for (const link of node.links) {
        const li = el('li');
        const a = el('a', null, link.label);
        a.href = link.href;
        li.append(a);
        links.append(li);
      }
      card.append(links);
    }

    const actions = el('div', 'diagnose-result-actions');
    const again = el('button', 'diagnose-btn primary', '回到这棵树的第一步');
    again.type = 'button';
    again.addEventListener('click', () => {
      trail = [];
      nodeId = tree.start;
      render();
    });
    actions.append(again);
    card.append(actions);
    return card;
  }

  function render() {
    if (!tree || !nodeId) return;
    const node = tree.nodes[nodeId];
    content.replaceChildren();
    if (!node) {
      content.append(el('p', 'diagnose-empty', '诊断数据缺少节点，请返回重新选择。'));
      return;
    }
    content.append(breadcrumb());
    content.append(node.type === 'result' ? renderResult(node) : renderQuestion(node));
    updateToolbar();
    renderSidebar();
  }

  function selectTree(id) {
    const next = trees.find((t) => t.id === id);
    if (!next) return;
    tree = next;
    nodeId = tree.start;
    trail = [];
    if (window.location.hash !== `#${id}`) {
      window.history.replaceState(null, '', `#${id}`);
    }
    render();
  }

  function goBack() {
    if (!trail.length) return;
    const prev = trail.pop();
    nodeId = prev.id;
    render();
  }

  backBtn?.addEventListener('click', goBack);
  resetBtn?.addEventListener('click', () => {
    if (!tree) return;
    trail = [];
    nodeId = tree.start;
    render();
  });
  window.addEventListener('hashchange', () => {
    const id = window.location.hash.slice(1);
    if (id && (!tree || tree.id !== id)) selectTree(id);
  });

  fetch('data/diagnose.json', { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('diagnose.json');
      return r.json();
    })
    .then((data) => {
      trees = Array.isArray(data) ? data : [];
      if (!trees.length) throw new Error('empty');
      const initial = window.location.hash.slice(1);
      selectTree(trees.some((t) => t.id === initial) ? initial : trees[0].id);
    })
    .catch(() => {
      content.replaceChildren(
        el('p', 'diagnose-empty', '诊断数据加载失败，请刷新页面，或直接浏览排障分支。')
      );
    });
})();
