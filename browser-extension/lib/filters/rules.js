// 广告与跟踪器过滤的**规则引擎**（纯逻辑，不碰 chrome.*）。
//
// # 设计取向：宁可少拦，不可错拦
//
// 广告过滤最怕的不是漏几个广告，是**拦坏正经页面**。
// 一个把支付回调拦掉的过滤器，用户会立刻删掉它，而且再也不会装第二次。
//
// 所以这里的默认档位很保守：
//
//   - `off`    什么都不做
//   - `basic`  只拦「专用广告/跟踪域名」（ad.doubleclick.net 这类
//              整个域名只为广告而存在的）
//   - `strict` 追加「已知跟踪器参数」与第三方统计脚本
//
// **不做元素隐藏**（cosmetic filtering）在这一阶段：那需要往每个页面注入 CSS，
// 出错的表现是"网站布局塌了"，比漏广告严重得多。留到单独阶段做，并且要能一键关。
//
// # 为什么规则是数据而不是代码
//
// 规则以数组形式给到 `declarativeNetRequest`，由浏览器内核匹配。
// 自己用 `webRequest` 拦需要 `webRequestBlocking`（MV3 已不授予普通扩展），
// 而且每条请求都过 JS，性能与隐私都更差。
//
// 本文件只负责**把规则算出来**，不负责安装——安装是模块的事（要碰 chrome.*）。

import { belongsTo, hostOf, matchesAny, normalizeDomain } from './domain.js';

/**
 * 「整个域名只为广告/跟踪而存在」的清单。
 *
 * 选取标准刻意严格：**必须整域都是广告/跟踪**，不能是"某公司的某个子域"。
 * 像 `google.com` 这种主域绝不能出现在这里——它的某个子域确实做广告统计，
 * 但拦掉整域会把搜索、地图、登录全干掉。
 */
export const AD_HOSTS = Object.freeze([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adsrvr.org',
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'moatads.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'casalemedia.com',
  'smartadserver.com',
  'yieldmo.com',
  'sharethrough.com',
  'teads.tv',
  'zedo.com',
  'adform.net',
  'mathtag.com',
  'bluekai.com',
  'demdex.net',
  'everesttech.net',
  'krxd.net',
  'ads-twitter.com',
  'analytics.twitter.com',
  'bat.bing.com',
  'clarity.ms',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'smartlook.com',
  'inspectlet.com',
  'luckyorange.com',
  'statcounter.com',
  'histats.com',
  'yandex.ru/metrika',
  'mc.yandex.ru',
]);

/**
 * `strict` 档才拦的域名。
 *
 * 这些域名**不全是**跟踪用途——比如 `facebook.com` 既是社交也是像素。
 * 拦整域在 strict 下可以接受（用户显式选择了更强隐私），但绝不能进 basic。
 */
export const STRICT_HOSTS = Object.freeze([
  'connect.facebook.net',
  'facebook.com/tr',
  'linkedin.com/li',
  'px.ads.linkedin.com',
  'snap.licdn.com',
  't.co',
  'analytics.tiktok.com',
  'business-api.tiktok.com',
]);

/**
 * 已知的跟踪参数。命中就从 URL 里剔掉，而不是整个请求拦掉。
 *
 * 为什么剔除而不是拦截：`?utm_source=x` 拦掉整个请求，等于把页面本身也拦了。
 * 剔参数是"去掉跟踪成分，保留内容"。
 *
 * 注意：这是**改写 URL**的规则，会出现在 `declarativeNetRequest` 的
 * `redirect.transform` 里。改写请求可能影响签名类接口，
 * 所以只在 strict 档启用，且限定为第三方请求。
 */
export const TRACKING_PARAMS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_anon_id',
  'oly_enc_id',
  'wickedid',
]);

/** 可选的过滤档位。 */
export const MODES = Object.freeze(['off', 'basic', 'strict']);

/** dNR 规则 id 的起始值。避开 1（保留给未来可能的更高优先级规则）。 */
export const RULE_ID_BASE = 1000;

/**
 * 把域名清单编成 declarativeNetRequest 的规则数组。
 *
 * 每条规则一个域名，id 递增。用 `requestDomains` 而不是 `urlFilter`：
 *
 *   - `urlFilter` 是子串匹配，`ad.doubleclick.net` 也会命中
 *     `https://evil.test/?x=ad.doubleclick.net`（无关请求被误杀）
 *   - `requestDomains` 由浏览器做域名归属判断，语义明确
 *
 * @param {ReadonlyArray<string>} hosts
 * @param {{idBase?:number, priority?:number, resourceTypes?:ReadonlyArray<string>}} [opts]
 */
export function buildBlockRules(hosts, opts = {}) {
  const idBase = opts.idBase ?? RULE_ID_BASE;
  const priority = opts.priority ?? 1;
  const resourceTypes = opts.resourceTypes ?? [
    'script',
    'image',
    'xmlhttprequest',
    'sub_frame',
    'stylesheet',
    'ping',
    'media',
    'font',
    'other',
  ];

  const rules = [];
  let id = idBase;
  for (const raw of hosts) {
    // 清单里出现的带路径形式（如 yandex.ru/metrika）不是纯域名：
    // 它的语义是"这个域名下的这个路径"，交给 buildPathBlockRules 处理。
    if (normalizeDomain(raw) === null || raw.includes('/')) continue;
    rules.push({
      id: id++,
      priority,
      action: { type: 'block' },
      condition: {
        requestDomains: [raw.toLowerCase()],
        resourceTypes: [...resourceTypes],
      },
    });
  }
  return rules;
}

/**
 * 带路径的拦截规则（`yandex.ru/metrika` 这类）。
 *
 * 用 `urlFilter` 的 `||domain^path` 语法。`^` 表示路径分隔符，
 * 避免 `/metrika` 命中 `/metrika-other`。
 */
export function buildPathBlockRules(entries, opts = {}) {
  const idBase = opts.idBase ?? RULE_ID_BASE;
  const priority = opts.priority ?? 1;
  const resourceTypes = opts.resourceTypes ?? ['script', 'image', 'xmlhttprequest', 'sub_frame'];

  const rules = [];
  let id = idBase;
  for (const entry of entries) {
    if (!entry.includes('/')) continue;
    const [domain, ...rest] = entry.split('/');
    if (!normalizeDomain(domain)) continue;
    const path = rest.join('/');
    if (!path || !/^[a-z0-9._-]+$/i.test(path)) continue;
    rules.push({
      id: id++,
      priority,
      action: { type: 'block' },
      condition: {
        urlFilter: `||${domain.toLowerCase()}^${path}`,
        resourceTypes: [...resourceTypes],
      },
    });
  }
  return rules;
}

/**
 * 按档位算出完整的规则集。
 *
 * 三条不变式：
 *
 *   1. **规则 id 全局唯一**。dNR 里 id 重复会导致整批安装失败——那是"过滤完全没生效"，
 *      而用户看到的是"开了但没拦住"，极难排查。
 *   2. **`off` 必须返回空数组**，不是"返回规则但不安装"。调用方据此卸载全部规则。
 *   3. **绝不出现 `allowAllRequests` 之外的放行规则**。放行规则一旦写错，
 *      整个过滤形同虚设，而且不会有任何报错。
 *
 * @param {'off'|'basic'|'strict'} mode
 * @param {{idBase?:number}} [opts]
 * @returns {{block: Array<object>, redirect: Array<object>}}
 */
export function buildRuleset(mode, opts = {}) {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode: ${mode}`);
  }
  if (mode === 'off') return { block: [], redirect: [] };

  const idBase = opts.idBase ?? RULE_ID_BASE;
  const block = [];
  let cursor = idBase;

  const plainAdHosts = AD_HOSTS.filter((h) => !h.includes('/'));
  const pathAdHosts = AD_HOSTS.filter((h) => h.includes('/'));

  block.push(...buildBlockRules(plainAdHosts, { idBase: cursor, priority: 2 }));
  cursor += plainAdHosts.length;
  block.push(...buildPathBlockRules(pathAdHosts, { idBase: cursor, priority: 2 }));
  cursor += pathAdHosts.length;

  const redirect = [];

  if (mode === 'strict') {
    const plainStrict = STRICT_HOSTS.filter((h) => !h.includes('/'));
    const pathStrict = STRICT_HOSTS.filter((h) => h.includes('/'));

    block.push(...buildBlockRules(plainStrict, { idBase: cursor, priority: 1 }));
    cursor += plainStrict.length;
    block.push(...buildPathBlockRules(pathStrict, { idBase: cursor, priority: 1 }));
    cursor += pathStrict.length;

    redirect.push(...buildParamStripRules(TRACKING_PARAMS, { idBase: cursor }));
  }

  return { block, redirect };
}

/**
 * 剔除跟踪参数的规则。
 *
 * 用 `redirect.transform.queryTransform.removeParams`：只删指定参数，
 * 其余原样保留。这样 `/article?id=5&utm_source=x` → `/article?id=5`，
 * 内容不变，跟踪成分没了。
 *
 * **限定 `thirdParty: true`**：第一方请求带上 utm 参数是网站自己的分析，
 * 改它可能影响某些站点的服务端签名校验。只动第三方请求，风险小得多。
 *
 * @param {ReadonlyArray<string>} params
 * @param {{idBase?:number}} [opts]
 */
export function buildParamStripRules(params, opts = {}) {
  const idBase = opts.idBase ?? RULE_ID_BASE;
  const rules = [];
  let id = idBase;
  for (const p of params) {
    if (!/^[a-z0-9_]+$/i.test(p)) continue; // 参数名形状统一，防止拼出奇怪的规则
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          transform: { queryTransform: { removeParams: [p] } },
        },
      },
      condition: {
        // 只对第三方请求生效；resourceTypes 覆盖整页与子资源，
        // 因为 utm 参数常出现在导航 URL 上
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'script'],
        // 字段名是 `domainType`，不是 `thirdParty`。
        // 写成 thirdParty 时 Chrome 会以
        // "Error at property 'condition': Unexpected property: 'thirdParty'"
        // 拒绝**整批**规则——单元测试里的假 dNR 不校验字段名，所以测不出来。
        // 这个缺陷是真实 Chrome 验收 T11b 抓到的。
        domainType: 'thirdParty',
      },
    });
  }
  return rules;
}

/**
 * 某个 host 会被哪一档拦掉？用于"为什么这个请求被拦了"的诊断。
 *
 * 返回命中的域名而不是布尔值——用户/开发者需要知道是哪条规则干的。
 *
 * @param {string} host
 * @param {'off'|'basic'|'strict'} mode
 * @returns {{blocked: boolean, by: string|null}}
 */
export function explainHost(host, mode) {
  if (mode === 'off') return { blocked: false, by: null };
  for (const d of AD_HOSTS) {
    if (d.includes('/')) continue;
    if (belongsTo(host, d)) return { blocked: true, by: d };
  }
  if (mode === 'strict') {
    for (const d of STRICT_HOSTS) {
      if (d.includes('/')) continue;
      if (belongsTo(host, d)) return { blocked: true, by: d };
    }
  }
  return { blocked: false, by: null };
}

/** 统计用：某个 URL 列表里有多少条会被拦。 */
export function countBlocked(urls, mode) {
  let blocked = 0;
  for (const u of urls) {
    const host = hostOf(u);
    if (host && explainHost(host, mode).blocked) blocked += 1;
  }
  return { total: urls.length, blocked };
}

export { matchesAny };
