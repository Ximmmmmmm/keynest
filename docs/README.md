# 文档索引

钥巢的文档分三类：**当前有效的**、**历史记录**、以及**阶段报告**。
这一页说明每一类是什么、该在什么时候看。

---

## 现在就看这些

| 文档 | 什么时候看 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 想了解整体结构：crate 划分、数据流、模块职责 |
| [THREAT_MODEL.md](THREAT_MODEL.md) | 想知道**哪些攻击防得住、哪些防不住**。这是安全承诺的权威来源 |
| [AUDIT.md](AUDIT.md) | 想了解已经做过的安全审查范围与结论 |
| [ROADMAP.md](ROADMAP.md) | 想看已完成什么、下一步做什么、还差什么 |
| [browser-extension-architecture.md](browser-extension-architecture.md) | 要给扩展加新模块时 |
| [browser-integration-architecture.md](browser-integration-architecture.md) | 要改浏览器集成链路时 |
| [../test/acceptance/README.md](../test/acceptance/README.md) | 要跑真实浏览器验收时 |

### 给普通用户

- [../README.md](../README.md) —— 功能、安装、使用
- [../README_EN.md](../README_EN.md) —— 英文版
- [../SECURITY.md](../SECURITY.md) —— 报告安全问题
- [../CHANGELOG.md](../CHANGELOG.md) —— 每个版本改了什么

---

## 历史记录

| 文档 | 内容 |
| --- | --- |
| [archive/tauri-migration.md](archive/tauri-migration.md) | 从 Tauri 迁到 Rust + egui 的原因与过程 |

---

## 阶段报告

[archive/phase-reports/](archive/phase-reports/) 里有 25 份阶段报告，
记录了浏览器桥接从 2.0 到 3.6 的每一步：做了什么、发现了什么缺陷、
为什么那样改。

它们的价值主要在**追溯**：

- 「某个设计当初为什么这么定」——报告里写了理由与被否决的方案
- 「某个缺陷是什么时候发现的、怎么修的」——比代码注释更完整
- 「当时哪些东西没做」——报告的「已知限制」段落通常比现在的代码更啰嗦

按阶段排序：

- **Phase 1–2**（`Phase1` ~ `Phase2.6`）：桥接的第一次设计与实现，
  包含「GUI 解锁一直失败」那段排查
- **Phase 2.6–2.7**（`Phase2.6` ~ `Phase2.7.4`）：从"能跑"到"能被验收"，
  以及真实 Chrome 验收夹具的诞生
- **Phase 2.8–2.9**：模块系统、权限清单、配置中心、广告过滤
- **Phase 3.0–3.6**：配置持久化、按站点暂停、面板系统、阅读模式、
  夜间模式、自动应用

> **注意**：这些报告记录的是**当时**的状态。
> 报告里说「尚未实现」的功能，现在可能已经实现了；
> 说「这是缺陷」的地方，可能已经修好。
> **当前状态一律以代码与本文档第一张表为准。**

---

## 约定

- 每完成一个阶段，在 `archive/phase-reports/` 加一份报告，
  固定结构：结论 / 根因 / 逐项结果 / 修改文件 / 测试 / 数据保护 / 已知限制 / 停止点
- 「停止点」必须写清楚**没有**推送、合并、发布
- 报告里的测试数字必须是**真实跑出来的**，不能是估计值
