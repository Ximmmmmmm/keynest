// 统一的错误基类。
//
// # 为什么要有一个基类
//
// 扩展里有四类错误来源：配置校验、权限声明、模块注册、运行时 handler。
// 如果它们各自定义 `class XError extends Error`，调用方只能靠字符串比对
// `e.name` 来分辨，或者干脆全部 `catch (e) {}` 吞掉——后者是 bug 温床。
//
// 一个共同基类 + 机器可读的 `code`，让"这是谁的错、该怎么处理"变成可判断的：
//
// ```js
// try { registry.register(spec) } catch (e) {
//   if (e instanceof KeyNestError) report(e.code);   // 可预期的配置问题
//   else throw e;                                     // 真 bug，别吞
// }
// ```
//
// # code 是契约，message 不是
//
// `code` 是稳定的、给程序看的；`message` 是给人看的，可以随时改文案。
// 跨进程边界（比如 SW → popup）只传 `code`——message 里可能带路径、
// 条目名这类不该过桥的信息。

export class KeyNestError extends Error {
  /**
   * @param {string} code 稳定的机器可读错误码
   * @param {string} message 给人看的说明（不跨进程边界）
   */
  constructor(code, message) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
