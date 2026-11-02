// 夜间模式：给页面套一层降低亮度的滤镜。
//
// # 为什么不用「改每个元素颜色」
//
// 常见做法是注入 `* { background: #111 !important; color: #eee !important }`。
// 那样必然把某些站点弄花：图标变黑块、渐变失效、`background-image` 上的
// 文字全看不见。
//
// 这里用**一层可调节的滤镜**：`html { filter: invert(1) hue-rotate(180deg) }`。
//
//   1. 白底黑字 → 黑底白字，色相不变（`hue-rotate` 抵消反色造成的偏色）
//   2. 图片再反色一次回到原样（只对 `img`/`video`/`svg` 做）
//   3. 不影响布局：滤镜是合成层，不改变盒模型
//
// 代价是滤镜会影响性能（尤其大页面滚动时）。所以：
//   - 提供 `brightness` 与 `contrast` 调节，而不是固定值
//   - 可以只对站点生效（有些站点自带深色主题，不该被反色）
//
// # 与阅读模式共用注入链路
//
// 都走 `lib/inject.js` 的 `injectInto`：先查权限再注入。
// 这一层在阶段 3.3 已经踩过坑，这里直接复用。

import { injectInto } from '../inject.js';

/** 注入到页面的函数。**完全自包含**：不能引用任何外部变量。 */
function darkToggle(args) {
  const CLASS = 'keynest-dark';
  const STYLE_ID = 'keynest-dark-style';

  const isActive = () => document.documentElement.classList.contains(CLASS);

  const uninstall = () => {
    const s = document.getElementById(STYLE_ID);
    const had = isActive();
    if (s) s.remove();
    if (had) document.documentElement.classList.remove(CLASS);
    return { ok: true, removed: Boolean(s || had) };
  };

  if (args.action === 'query') {
    return { ok: true, active: isActive() };
  }
  if (args.action === 'uninstall') {
    return uninstall();
  }

  if (isActive()) {
    // 重复启用：只更新参数，不重复插入样式
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    document.documentElement.classList.remove(CLASS);
  }

  // 参数夹紧：值可能来自存储里的脏数据。
  // 滤镜写坏的表现是整页变花，而不是报错。
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const brightness = clamp(args.brightness, 40, 120, 92);
  const contrast = clamp(args.contrast, 60, 140, 100);
  const sepia = clamp(args.sepia, 0, 40, 0);

  const filter =
    `invert(1) hue-rotate(180deg) brightness(${brightness}%) contrast(${contrast}%)` +
    (sepia > 0 ? ` sepia(${sepia}%)` : '');

  const css =
    `html.${CLASS} { background: #fff !important; }` +
    // 反色 + 色相旋转作用在根元素上，整页覆盖
    `html.${CLASS} body { filter: ${filter}; }` +
    // 图片/视频/SVG 再反一次回到原样（否则照片会变成负片）
    `html.${CLASS} img,html.${CLASS} video,html.${CLASS} canvas,` +
    `html.${CLASS} svg image,html.${CLASS} picture {` +
    `filter: invert(1) hue-rotate(180deg) !important;}` +
    // iframe 内部不受滤镜影响（跨域也无法注入），至少别让它刺眼
    `html.${CLASS} iframe { opacity: 0.92; }`;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
  document.documentElement.classList.add(CLASS);

  return { ok: true, brightness, contrast, sepia };
}

export const BRIGHTNESS_RANGE = [40, 120];
export const CONTRAST_RANGE = [60, 140];
export const SEPIA_RANGE = [0, 40];

/**
 * @param {object} deps
 * @param {object} deps.scripting
 * @param {object} [deps.permissions]
 * @param {object} deps.webNavigation
 */
export function createDarkModule(deps) {
  /** 把配置变成注入参数。统一在一处算，handler 不重复。 */
  function argsFrom(ctx, action) {
    return {
      action,
      brightness: ctx.config.get('brightness'),
      contrast: ctx.config.get('contrast'),
      sepia: ctx.config.get('sepia'),
    };
  }

  return {
    id: 'dark',
    title: '夜间模式',
    description: '把明亮页面调暗，图片保持原色',
    defaultEnabled: false,
    requires: ['scripting', 'hostHttps'],
    config: {
      brightness: {
        type: 'number',
        default: 92,
        min: BRIGHTNESS_RANGE[0],
        max: BRIGHTNESS_RANGE[1],
        integer: true,
      },
      contrast: {
        type: 'number',
        default: 100,
        min: CONTRAST_RANGE[0],
        max: CONTRAST_RANGE[1],
        integer: true,
      },
      sepia: {
        type: 'number',
        default: 0,
        min: SEPIA_RANGE[0],
        max: SEPIA_RANGE[1],
        integer: true,
      },
    },
    handlers: [
      {
        type: 'dark.toggle',
        handle: async (msg, ctx) => {
          const tabId = msg.tabId;
          if (!Number.isInteger(tabId)) return { ok: false, error: 'BAD_ARGS' };
          const action = msg.action === 'uninstall' ? 'uninstall' : 'install';

          const out = await injectInto(deps, tabId, darkToggle, [argsFrom(ctx, action)], {
            // 卸载不需要权限：样式本来就是我们自己加的
            needPermission: action === 'install',
          });
          if (!out.ok) return out;
          return { ok: true, ...out.result };
        },
      },
      {
        type: 'dark.query',
        handle: async (msg) => {
          const tabId = msg.tabId;
          if (!Number.isInteger(tabId)) return { ok: false, error: 'BAD_ARGS' };
          const out = await injectInto(deps, tabId, darkToggle, [{ action: 'query' }], {
            needPermission: false,
          });
          if (!out.ok) return out;
          return { ok: true, ...out.result };
        },
      },
    ],
  };
}

export { darkToggle };
