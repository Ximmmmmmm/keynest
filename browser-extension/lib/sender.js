// 消息来源分类（纯逻辑，可测）。
//
// # 为什么不能用 sender.tab 判定身份
//
// `sender.tab` 只说明"这条消息来自某个标签页上下文"，它**不能**证明
// "这是扩展自己的特权页面"。`options_ui` 配了 `open_in_tab: true` 时，
// 扩展自己的选项页就在标签页里运行 → `sender.tab` 存在 →
// 按"有 tab 就是 content script"的判据会把特权页面误判成 content script。
//
// 正确判据是 **sender.url 的精确分类**：
//   1. `sender.id` 必须等于本扩展 ID（排除别的扩展）
//   2. URL 以 `chrome-extension://<id>/` 开头且路径在白名单里 → 特权页面
//   3. 否则若带 tab → 网页里的 content script
//   4. 其余 → unknown

/**
 * @param {{id?:string, url?:string, tab?:{id?:number}, frameId?:number}} sender
 * @param {{extensionId:string, extensionBase:string, privilegedPages:string[]}} ctx
 * @returns {'popup'|'content'|'unknown'}
 */
export function classifySender(sender, ctx) {
  if (!sender || typeof sender !== 'object') return 'unknown';
  if (!sender.id || sender.id !== ctx.extensionId) return 'unknown';

  const url = typeof sender.url === 'string' ? sender.url : '';

  if (url.startsWith(ctx.extensionBase)) {
    const path = url.slice(ctx.extensionBase.length).split(/[?#]/)[0];
    return ctx.privilegedPages.includes(path) ? 'popup' : 'unknown';
  }

  if (sender.tab && Number.isInteger(sender.tab.id)) return 'content';
  return 'unknown';
}
