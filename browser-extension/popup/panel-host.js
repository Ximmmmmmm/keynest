// Popup 的**面板系统**：每个模块往 popup 里贡献一块 UI，而不是往 popup.js 里堆 if。
//
// # 为什么需要这个
//
// 阶段 3.1 结束时，popup 里已经有两块：密码填充、广告过滤暂停。
// 两者都是"手写 HTML 段落 + 一段 `refreshXxx()` 函数 + 在 init 里调用"。
//
// 再加第三个模块（阅读模式、截图、笔记……）就会变成：
//
//   - popup.html 里越来越多 `<section id="xxx-section">`
//   - popup.js 里越来越多 `refreshXxx()`，且它们各自要判断"模块启用了吗"
//   - 某个模块出错会拖垮整个 popup 的渲染
//
// 这个文件把这件事变成"注册一个面板"。面板自己负责：
//   1. 声明它关心哪个模块
//   2. 在自己的容器里渲染
//   3. 单个面板抛错不影响其他面板
//
// # 这个文件不做什么
//
// - 不碰 chrome.*（渲染与消息由面板自己处理，便于单测）
// - 不做样式（面板自带 class，样式在 popup.css 里）

/**
 * @typedef {object} Panel
 * @property {string} id            面板 id（唯一）
 * @property {string} [moduleId]    依赖的模块 id；模块未启用时整个面板不渲染
 * @property {number} [order]       排序，小的在前
 * @property {(() => boolean|Promise<boolean>)} [available]
 *   额外的可用性判断（例如"拿不到当前站点域名"）。
 *   返回 false 时**连容器都不创建**——留下空容器会让布局出现不可见的间隙，
 *   也会让 `#panels section` 的计数变得没有意义。
 * @property {(host: PanelHost) => Promise<void>|void} render
 */

export class PanelHost {
  /** @type {Map<string, Panel>} */
  #panels = new Map();

  /**
   * @param {object} deps
   * @param {HTMLElement} deps.root      面板挂载点
   * @param {(type:string, msg?:object) => Promise<any>} deps.send  发消息给 SW
   * @param {(text:string|null) => void} deps.setError  统一错误显示
   */
  constructor(deps) {
    this.root = deps.root;
    this.send = deps.send;
    this.setError = deps.setError || (() => {});
    /** 模块启用状态缓存，避免每个面板各问一次 modules.list */
    this.enabledModules = new Set();
  }

  /**
   * 注册面板。id 重复直接抛——静默覆盖会让"我明明注册了却不显示"极难排查。
   * @param {Panel} panel
   */
  register(panel) {
    if (!panel || typeof panel.id !== 'string' || !panel.id) {
      throw new Error('panel.id 必须是非空字符串');
    }
    if (this.#panels.has(panel.id)) {
      throw new Error(`面板重复注册: ${panel.id}`);
    }
    if (typeof panel.render !== 'function') {
      throw new Error(`面板 ${panel.id} 缺少 render`);
    }
    this.#panels.set(panel.id, panel);
  }

  /** 拉一次模块启用状态，供 `moduleId` 过滤用。 */
  async loadModuleState() {
    try {
      const res = await this.send('modules.list');
      if (res && res.ok && Array.isArray(res.modules)) {
        this.enabledModules = new Set(res.modules.filter((m) => m.enabled).map((m) => m.id));
      } else {
        // 读不到就当全部未启用：宁可不显示面板，也不显示一个点了会失败的面板
        this.enabledModules = new Set();
      }
    } catch {
      this.enabledModules = new Set();
    }
  }

  /**
   * 渲染所有面板。
   *
   * 三个刻意的行为：
   *
   *   1. **按 order 排序**，order 相同按注册顺序（Map 保序）
   *   2. **单个面板抛错不影响其他**：捕获后在该面板位置显示一行小字，
   *      而不是让整个 popup 白屏
   *   3. **模块未启用的面板整块跳过**，连容器都不创建——
   *      "空容器 + 隐藏"会让布局里留下不可见的间隙
   */
  async renderAll() {
    await this.loadModuleState();

    const panels = [...this.#panels.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100)
    );

    this.root.replaceChildren();

    for (const panel of panels) {
      if (panel.moduleId && !this.enabledModules.has(panel.moduleId)) continue;

      // 面板自己声明"现在能不能显示"。抛错按不可用处理——
      // 一个判断不出来的面板不该冒出一个空框。
      if (typeof panel.available === 'function') {
        let ok = false;
        try {
          ok = await panel.available();
        } catch {
          ok = false;
        }
        if (!ok) continue;
      }

      const section = document.createElement('section');
      section.className = 'panel';
      section.dataset.panel = panel.id;
      this.root.append(section);

      try {
        await panel.render(this.forPanel(section));
      } catch (e) {
        // 只显示稳定信息，不显示 e.message（可能含内部细节）
        section.replaceChildren();
        const note = document.createElement('p');
        note.className = 'panel-error';
        note.textContent = '这个面板暂时不可用';
        section.append(note);
      }
    }
  }

  /** 给某个面板用的渲染上下文。 */
  forPanel(section) {
    return {
      section,
      send: this.send,
      /** 面板内错误显示（会同时写进全局错误条，便于用户看到） */
      error: (text) => this.setError(text),
      /** 创建子元素并挂到 section 上的小工具 */
      el: (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        section.append(node);
        return node;
      },
    };
  }

  /** 已注册的面板 id（测试用）。 */
  ids() {
    return [...this.#panels.keys()];
  }
}
