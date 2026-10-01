/**
 * 命令站搜索逻辑(多分支版)
 *
 * 与上游的差异:
 *  1. 不再用 origin + pathname 反算站点根。上游正则写死 "/c/",无法泛化到分支路径;
 *     而任何泛化版本都会遇到同一歧义 —— "/base/list.html" 中的 "base" 是部署基路径
 *     还是分支名,从 URL 无从判断。改为由构建期注入相对前缀(#root_prefix),
 *     既准确又天然支持子路径部署。
 *  2. 链接由 `${root}/c${p}.html` 改为 `${prefix}${p}.html` —— p 已是完整路径(/linux/helm)。
 *  3. 结果追加分支徽标(显示名查 branches,而非直接显示 id)。
 *  4. 查询串与结果文本做正则转义与 HTML 转义(见下方 escapeRegExp / escapeHtml)。
 */
var sortArray = function (a, b) {
  return a.nIdx - b.nIdx;
};

function indexOfCatch(i) {
  return i > -1;
}

// 转义正则元字符。上游直接把用户输入拼进 RegExp,输入 "(" 或 "[" 会抛
// SyntaxError 并让整个搜索失效。
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 转义 HTML。高亮在「已转义文本」上进行,查询串同样先转义,
// 两侧转义一致故匹配位置对齐,实体不会被拦腰截断。
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

new (class {
  query = '';
  query_size = 5;
  page_size = 50;

  $$(id) {
    return document.getElementById(id);
  }

  constructor() {
    const $ = (id) => document.getElementById(id);
    this.commands = typeof commands !== 'undefined' ? commands : [];
    this.branches = typeof branches !== 'undefined' ? branches : [];
    this.branchNames = {};
    this.branches.forEach((b) => {
      this.branchNames[b.id] = b.name;
    });

    this.elm_query = $('query');
    this.elm_btn = $('search_btn');
    this.elm_result = $('result');
    this.elm_search_result = $('search_list_result');

    // 站内链接一律用构建期注入的相对前缀('' 或 '../'),不做任何路径推断。
    //
    // 上游用 origin + pathname 反算站点根,其正则写死了 "/c/",无法泛化到分支路径;
    // 而任何泛化版本都会遇到同一个歧义:在 "/base/list.html" 里,"base" 究竟是
    // 部署基路径还是分支名,从 URL 本身无从判断。构建期知道答案,直接注入即可,
    // 同时也天然支持子路径部署(GitHub Pages 等)。
    const prefixEl = $('root_prefix');
    this.root_prefix = prefixEl ? prefixEl.value : '';

    this.init();
    this.goToIndex();
  }

  goToIndex() {
    const target = this.root_prefix || './';
    const anchors = document.getElementsByTagName('A');
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].pathname === '/' && !/^https?:/i.test(anchors[i].protocol)) {
        anchors[i].href = target;
      }
    }
  }

  bindEvent(el, type, fn) {
    if (el.addEventListener) el.addEventListener(type, fn, false);
    else if (el.attachEvent) el.attachEvent('on' + type, fn);
  }

  isSreachIndexOF(source, query) {
    if (!source || !query) return -1;
    return source.toLowerCase().indexOf(query.toLowerCase());
  }

  getQueryString(name) {
    const reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)', 'i');
    const r = decodeURIComponent(window.location.hash.replace(/^(\#\!|\#)/, '')).match(reg);
    return r != null ? unescape(r[2]) : null;
  }

  pushState() {
    if (window.history && window.history.pushState) {
      if (this.query) history.pushState({}, 'linux_commands', '#!kw=' + this.query);
      else history.pushState({}, 'linux_commands', window.location.pathname);
    }
  }

  simple(template, data) {
    return template.replace(/\$\w+\$/gi, function (key) {
      const k = key.replace(/\$/g, '');
      const v = data[k];
      return v === undefined ? '' : v;
    });
  }

  createKeyworldsHTML(item, query, withDesc) {
    const kw = '<i class="kw">$1</i>';
    // p 形如 "/linux/helm",去掉前导斜杠后拼相对前缀 → "linux/helm" 或 "../linux/helm"
    const root = this.root_prefix;

    let name = escapeHtml(item.n);
    let des = escapeHtml(item.d);

    if (query) {
      // 查询串与文本都已 HTML 转义,再转义正则元字符
      const re = new RegExp('(' + escapeRegExp(escapeHtml(query)) + ')', 'ig');
      name = name.replace(re, kw);
      des = des.replace(re, kw) || '';
    }

    const branchName = escapeHtml(this.branchNames[item.b] || item.b || '');
    const href = root + String(item.p).replace(/^\//, '').replace(/"/g, '%22') + '.html';

    return this.simple(
      `<a href="$url$"><strong>$name$</strong> - $des$ <em class="branch">$branch$</em></a>` +
        (withDesc ? '<p></p>' : ''),
      { name: name, url: href, des: des, branch: branchName }
    );
  }

  searchResult(full) {
    const list = this.commands;
    const size = list.length;
    const out = [];
    const limit = full ? this.page_size : this.query_size;
    const nameHits = [];
    const descHits = [];

    if (indexOfCatch(toString.call(list).indexOf('Array')) && size) {
      for (let i = 0; i < size && list[i]; i++) {
        const nIdx = this.isSreachIndexOF(list[i].n, this.query);
        const dIdx = this.isSreachIndexOF(list[i].d, this.query);
        const item = list[i];
        if (indexOfCatch(nIdx)) {
          item.nIdx = nIdx;
          nameHits.push(item);
        } else if (indexOfCatch(dIdx)) {
          item.dIdx = dIdx;
          descHits.push(item);
        }
      }
    }

    nameHits.sort(sortArray);
    descHits.sort(sortArray);
    nameHits.concat(descHits).slice(0, limit).forEach((item) => {
      out.push(this.createKeyworldsHTML(item, this.query, full));
    });

    const target = full ? this.elm_search_result : this.elm_result;
    target.innerHTML = '';
    out.forEach((html) => {
      const li = document.createElement('li');
      li.innerHTML = html;
      target.appendChild(li);
    });

    if (!out.length) {
      const li = document.createElement('LI');
      const span = document.createElement('span');
      span.innerText = this.query
        ? '没有搜索到任何内容，请尝试输入其它字符！'
        : '请尝试输入一些字符，进行搜索！';
      li.appendChild(span);
      target.appendChild(li);
    }
  }

  selectedResult(dir) {
    const items = this.elm_result.children;
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].className === 'ok') {
        items[i].className = '';
        idx = dir === 'up' ? i - 1 : i + 1;
        break;
      }
    }
    if (items[idx]) items[idx].className = 'ok';
  }

  isSelectedResult() {
    const items = this.elm_result.children;
    let found = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].className === 'ok') {
        found = items[i];
        break;
      }
    }
    return found;
  }

  init() {
    const self = this;
    const toggle = (show) => {
      self.elm_result.style.display = show || 'none';
    };

    const kw = self.getQueryString('kw');
    this.elm_query.value = kw;
    this.query = kw || '';

    if (this.elm_search_result) self.searchResult(true);

    this.bindEvent(this.elm_query, 'input', function (e) {
      self.query = e.target.value;
      self.pushState();
      if (self.query) self.searchResult();
      else toggle();
      if (self.elm_search_result) self.elm_btn.click();
      else toggle(self.query ? 'block' : 'none');
    });

    this.bindEvent(this.elm_btn, 'click', function () {
      toggle();
      if (self.elm_search_result) self.searchResult(true);
      else window.location.href = self.root_prefix + 'list.html#!kw=' + self.query;
    });

    this.bindEvent(this.elm_query, 'focus', function () {
      self.searchResult();
      if (self.query) toggle('block');
    });

    this.bindEvent(this.elm_query, 'blur', function () {
      setTimeout(function () {
        toggle();
      }, 300);
    });

    this.bindEvent(document, 'keyup', function (e) {
      if (e.keyCode === 40) self.selectedResult('down');
      if (e.keyCode === 38) self.selectedResult('up');
      if (e.key === 'Enter') {
        const sel = self.isSelectedResult();
        if (!sel) return self.elm_btn.click();
        if (sel.children[0]) sel.children[0].click();
      }
    });

    if (kw) self.searchResult();
  }
})();
