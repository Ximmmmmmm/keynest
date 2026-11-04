// 最小 DOM 替身：只支持阅读模式实际用到的那些 API。
//
// # 为什么自己写而不是装 jsdom
//
// 项目的依赖策略是「不引入未经审查的高风险依赖」。为了测 200 行 DOM 操作代码
// 引入 jsdom（几十个传递依赖、自己的 DOM 语义差异）不划算。
//
// # 关键设计：不认识的语法要**报错**，不是静默返回空
//
// 假实现最危险的失败方式是"宽松"——它接受任何输入，于是测试全绿，
// 真实浏览器却挂。阶段 2.9 的 `thirdParty` 缺陷就是这么漏掉的。
//
// 所以这里的 `querySelector` 只认下面这几种形态，其它一律抛
// `UnsupportedSelector`，强迫测试作者去改替身，而不是让测试悄悄失去意义。
//
// 支持的形态：
//   'article'                 —— 纯标签名
//   '[role="main"]'           —— 属性等值
//   'div, section, td'        —— 逗号分隔（多选）
//   'p'                       —— 纯标签名

export class UnsupportedSelector extends Error {}

/* ---------------------------- 选择器解析 ---------------------------- */

/** 把选择器字符串解析成谓词数组。不认识的形态直接抛。 */
export function parseSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new UnsupportedSelector(`空选择器`);
  }
  return selector.split(',').map((part) => parseSimple(part.trim()));
}

function parseSimple(s) {
  if (!s) throw new UnsupportedSelector('空的简单选择器');

  // [attr="value"]
  const attr = s.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
  if (attr) {
    const [, name, value] = attr;
    return (el) => el.getAttribute(name) === value;
  }
  // [attr]（仅存在性）
  const attrOnly = s.match(/^\[([a-zA-Z-]+)\]$/);
  if (attrOnly) {
    return (el) => el.getAttribute(attrOnly[1]) !== null;
  }
  // 纯标签名
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) {
    const tag = s.toUpperCase();
    return (el) => el.tagName === tag;
  }
  throw new UnsupportedSelector(
    `替身不支持选择器 "${s}"。要么改用受支持的形态，要么扩充 minidom.js。`
  );
}

/* ---------------------------- 节点 ---------------------------- */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...cs) {
    for (const c of cs) this.set.add(c);
  }
  remove(...cs) {
    for (const c of cs) this.set.delete(c);
  }
  contains(c) {
    return this.set.has(c);
  }
  get value() {
    return [...this.set].join(' ');
  }
  toString() {
    return this.value;
  }
}

class Style {
  constructor() {
    this.props = new Map();
    this._text = '';
  }
  set textContent(v) {
    this._text = v;
  }
  get textContent() {
    return this._text;
  }
  removeProperty(p) {
    this.props.delete(p);
  }
  setProperty(p, v) {
    this.props.set(p, v);
  }
  getPropertyValue(p) {
    return this.props.get(p) || '';
  }
}

export class MiniElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.classList = new ClassList();
    this.style = new Style();
    this.dataset = {};
    this._text = null; // 只在文本节点上使用
  }

  /* ---- 属性 ---- */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get className() {
    return this.classList.value;
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  /* ---- 文本 ---- */
  /** 与真实 DOM 一致：元素的 textContent 是所有后代文本的拼接。 */
  get textContent() {
    if (this._text !== null) return this._text;
    let out = '';
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = String(v);
  }

  /* ---- 树操作 ---- */
  get children() {
    return this.childNodes.filter((c) => c instanceof MiniElement);
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n;
      // 从原父节点摘下来（与真实 DOM 一致）
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter((x) => x !== node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  /** appendChild：真实 DOM 里与 append 行为略有不同（返回子节点），这里对齐到 append。 */
  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this);
      this.parentNode = null;
    }
  }

  /** 克隆。`deep` 默认 true（与真实 DOM 的 cloneNode(true) 一致）。 */
  cloneNode(deep = true) {
    const copy = new MiniElement(this.tagName, this.ownerDocument);
    for (const [k, v] of this.attributes) copy.attributes.set(k, v);
    // class 属性也会复制（真实 DOM 同样）
    const cls = this.getAttribute('class');
    if (cls) copy.className = cls;
    copy.classList.set = new Set(this.classList.set);
    copy.style.textContent = this.style.textContent;
    if (this._text !== null) copy._text = this._text;
    if (deep) {
      for (const c of this.childNodes) {
        const cc = c.cloneNode(true);
        cc.parentNode = copy;
        copy.childNodes.push(cc);
      }
    }
    return copy;
  }

  /* ---- 查询 ---- */
  /** 后代（不含自身），前序。 */
  *descendants() {
    for (const c of this.children) {
      yield c;
      yield* c.descendants();
    }
  }

  querySelectorAll(selector) {
    const preds = parseSelector(selector);
    const out = [];
    for (const el of this.descendants()) {
      if (preds.some((p) => p(el))) out.push(el);
    }
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    for (const el of this.descendants()) if (el.id === id) return el;
    return null;
  }
}

export class MiniText {
  constructor(text, ownerDocument) {
    this._text = String(text);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.nodeType = 3;
  }
  get textContent() {
    return this._text;
  }
  cloneNode() {
    return new MiniText(this._text, this.ownerDocument);
  }
}

export class MiniDocument {
  constructor() {
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.append(this.head, this.body);
  }
  createElement(tag) {
    return new MiniElement(tag, this);
  }
  createTextNode(text) {
    return new MiniText(text, this);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  getElementById(id) {
    return this.documentElement.getElementById(id);
  }
  get defaultView() {
    return null;
  }
}

/** 便捷构造：`<body><div><p>…</p></div></body>` 形式的简写。 */
export function buildDocument(spec) {
  const doc = new MiniDocument();
  const walk = (parent, spec) => {
    // spec: { tag, attrs?, text?, children? } 或 字符串（文本）
    if (typeof spec === 'string') {
      parent.append(doc.createTextNode(spec));
      return;
    }
    const el = doc.createElement(spec.tag);
    for (const [k, v] of Object.entries(spec.attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'id') el.id = v;
      else el.setAttribute(k, v);
    }
    if (spec.text !== undefined) el.append(doc.createTextNode(spec.text));
    for (const child of spec.children || []) walk(el, child);
    parent.append(el);
  };
  for (const node of spec.body || []) walk(doc.body, node);
  return doc;
}
