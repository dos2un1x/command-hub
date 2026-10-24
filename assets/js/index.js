/**
 * 命令站搜索逻辑(多分支版)
 *
 * 索引按需加载:dt.js 只在用户聚焦搜索框、输入关键词或打开列表页时下载,
 * 不再随每个详情页首屏加载 200+ KB。
 *
 * 站点根前缀由构建期注入(#root_prefix),不从 origin/pathname 反推:
 * 在 "/base/list.html" 里,"base" 是部署基路径还是分支名,仅凭 URL 无法判断;
 * 构建期知道答案,直接注入前缀,同时也支持子路径部署。
 * 链接由 `${prefix}${p}.html` 生成,p 已是完整路径(/linux/helm)。
 * 查询串与结果文本做正则转义与 HTML 转义(见下方 escapeRegExp / escapeHtml)。
 */
var sortArray = function (a, b) {
  return a.nIdx - b.nIdx;
};

function indexOfCatch(i) {
  return i > -1;
}

// 转义正则元字符。用户输入会拼进 RegExp,输入 "(" 或 "[" 会抛
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
  commands = [];
  branches = [];
  branchNames = {};
  indexReady = false;
  indexPromise = null;

  constructor() {
    const $ = (id) => document.getElementById(id);
    this.elm_query = $('query');
    this.elm_btn = $('search_btn');
    this.elm_result = $('result');
    this.elm_search_result = $('search_list_result');

    // 站内链接一律用构建期注入的相对前缀('' 或 '../'),不做任何路径推断。
    //
    // 不用 origin + pathname 反推站点根:在 "/base/list.html" 里,"base" 究竟是
    // 部署基路径还是分支名,从 URL 本身无从判断。构建期知道答案,直接注入前缀,
    // 同时也天然支持子路径部署(GitHub Pages 等)。
    const prefixEl = $('root_prefix');
    this.root_prefix = prefixEl ? prefixEl.value : '';

    // scripts.ejs 把带版本号的 dt.js 地址写在 data-search-index 上。
    const scriptEl = document.currentScript;
    this.index_url =
      (scriptEl && scriptEl.dataset && scriptEl.dataset.searchIndex) ||
      this.root_prefix + 'js/dt.js';

    this.init();
    this.goToIndex();
  }

  /** 首次需要搜索时再加载索引;并发调用复用同一个 Promise。 */
  loadIndex() {
    if (this.indexReady) return Promise.resolve();
    if (this.indexPromise) return this.indexPromise;

    this.indexPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = this.index_url;
      script.onload = () => {
        this.commands = Array.isArray(window.commands) ? window.commands : [];
        this.branches = Array.isArray(window.branches) ? window.branches : [];
        this.branchNames = {};
        this.branches.forEach((b) => {
          this.branchNames[b.id] = b.name;
        });
        this.indexReady = true;
        resolve();
      };
      script.onerror = () => {
        this.indexPromise = null;
        reject(new Error('search index load failed'));
      };
      document.head.appendChild(script);
    });
    return this.indexPromise;
  }

  loadIndexThen(fn) {
    this.loadIndex()
      .then(fn)
      .catch(() => {
        /* 索引加载失败时保留页面原有搜索框,不阻断正文阅读 */
      });
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
    const reg = new RegExp('(^|&)' + escapeRegExp(name) + '=([^&]*)(&|$)', 'i');
    const raw = window.location.hash.replace(/^(\#\!|\#)/, '');
    const matched = raw.match(reg);
    if (matched == null) return null;
    try {
      return decodeURIComponent(matched[2]);
    } catch {
      // 用户可能直接输入了未编码的 "%";退化为原文,避免整个搜索初始化失败。
      return matched[2];
    }
  }

  replaceHistory() {
    if (!window.history || !window.history.replaceState) return;
    // 输入过程只替换当前历史项,避免每敲一个字符就新增一条记录。
    const target = this.query
      ? '#!kw=' + encodeURIComponent(this.query)
      : window.location.pathname;
    try {
      window.history.replaceState({}, 'dos2unix_commands', target);
    } catch {
      /* file:// 预览等环境可能禁止改历史,忽略即可 */
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
    const aliasHits = [];

    if (Array.isArray(list) && size) {
      for (let i = 0; i < size && list[i]; i++) {
        const nIdx = this.isSreachIndexOF(list[i].n, this.query);
        const dIdx = this.isSreachIndexOF(list[i].d, this.query);
        const aIdx = this.isSreachIndexOF(list[i].a || '', this.query);
        const item = list[i];
        if (indexOfCatch(nIdx)) {
          item.nIdx = nIdx;
          nameHits.push(item);
        } else if (indexOfCatch(dIdx)) {
          item.dIdx = dIdx;
          descHits.push(item);
        } else if (indexOfCatch(aIdx)) {
          // 别名命中排在名称/描述之后,但仍参与高亮与跳转。
          item.nIdx = 100000 + aIdx;
          aliasHits.push(item);
        }
      }
    }

    nameHits.sort(sortArray);
    descHits.sort(sortArray);
    aliasHits.sort(sortArray);
    nameHits.concat(descHits, aliasHits).slice(0, limit).forEach((item) => {
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
    this.elm_query.value = kw || '';
    this.query = kw || '';

    // 列表页是搜索专用页,立即加载索引;其它页面等用户真正开始搜索。
    if (this.elm_search_result) {
      this.loadIndexThen(() => self.searchResult(true));
    }

    this.bindEvent(this.elm_query, 'input', function (e) {
      self.query = e.target.value;
      self.replaceHistory();
      if (!self.query) {
        toggle();
        if (self.elm_search_result) self.searchResult(true);
        return;
      }
      if (self.elm_search_result) {
        self.loadIndexThen(() => self.searchResult(true));
      } else {
        self.loadIndexThen(() => {
          self.searchResult();
          toggle('block');
        });
      }
    });

    this.bindEvent(this.elm_btn, 'click', function () {
      if (self.elm_search_result) {
        toggle();
        self.loadIndexThen(() => self.searchResult(true));
      } else {
        const hash = self.query ? '#!kw=' + encodeURIComponent(self.query) : '';
        window.location.href = self.root_prefix + 'list.html' + hash;
      }
    });

    this.bindEvent(this.elm_query, 'focus', function () {
      if (!self.query) return;
      if (self.elm_search_result) {
        self.loadIndexThen(() => self.searchResult(true));
        return;
      }
      self.loadIndexThen(() => {
        self.searchResult();
        toggle('block');
      });
    });

    this.bindEvent(this.elm_query, 'blur', function () {
      setTimeout(function () {
        toggle();
      }, 300);
    });

    // 只在搜索框内响应方向键与 Enter。否则在复习页、诊断向导里
    // 按 Enter 会被当成“点击搜索”,把用户带回 list.html。
    this.bindEvent(document, 'keyup', function (e) {
      if (e.target !== self.elm_query) return;
      if (e.keyCode === 40) self.selectedResult('down');
      if (e.keyCode === 38) self.selectedResult('up');
      if (e.key === 'Enter') {
        const sel = self.isSelectedResult();
        if (!sel) return self.elm_btn.click();
        if (sel.children[0]) sel.children[0].click();
      }
    });

    if (kw && !this.elm_search_result) {
      this.loadIndexThen(() => {
        self.searchResult();
        toggle('block');
      });
    }
  }
})();
