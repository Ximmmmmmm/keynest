// 把 kinds::template 改成三元组（label, secret, hint），并更新 builtin_template。
const fs = require('fs');
const p = 'rust/keynest-core/src/vault.rs';
let s = fs.readFileSync(p, 'utf8');
const NL = String.fromCharCode(10);

// 1) 函数签名
s = s.replace(
  "    pub fn template(name: &str) -> &'static [(&'static str, bool)] {",
  "    /// 返回（标签, 是否打码, 输入提示）。\n" +
  "    ///\n" +
  "    /// 提示语是**纯增量**的：老库里存的模板没有 hint，读进来是空串，\n" +
  "    /// 编辑框就不显示灰字。这不需要数据迁移。\n" +
  "    pub fn template(name: &str) -> &'static [(&'static str, bool, &'static str)] {",
);

// 2) 每个内置类型的字面量补第三项
const swaps = [
  // CARD
  ['("持卡人", false),', '("持卡人", false, "持卡人姓名"),'],
  ['("卡号", true),', '("卡号", true, "16 位卡号"),'],
  ['("有效期", false),', '("有效期", false, "MM/YY"),'],
  ['("安全码", true),', '("安全码", true, "背面 3–4 位"),'],
  ['("发卡行", false),', '("发卡行", false, "例如 招商银行"),'],
  // IDENTITY
  ['("姓名", false),', '("姓名", false, "证件上的姓名"),'],
  ['("证件号", true),', '("证件号", true, "身份证 / 护照号"),'],
  ['("出生日期", false),', '("出生日期", false, "YYYY-MM-DD"),'],
  ['("地址", false),', '("地址", false, "常住地址"),'],
  ['("电话", false),', '("电话", false, "带国家码，如 +86 138…"),'],
  // APIKEY
  ['("服务商", false),', '("服务商", false, "OpenAI / Anthropic / AWS / 自建…"),'],
  ['("环境", false),', '("环境", false, "prod / staging / dev"),'],
  ['("Key ID", false),', '("Key ID", false, "AKIA… 这类公开标识，没有就留空"),'],
  ['("Secret", true),', '("Secret", true, "sk-… / 访问密钥，粘贴进来"),'],
  ['("权限范围", false),', '("权限范围", false, "只读 / 读写 / 具体 scope"),'],
  ['("Base URL", false),', '("Base URL", false, "走代理或自建时填，官方留空"),'],
  ['("到期时间", false),', '("到期时间", false, "YYYY-MM-DD，不过期就留空"),'],
  ['("轮换周期", false),', '("轮换周期", false, "例如 90 天"),'],
];
for (const [a, b] of swaps) {
  if (!s.includes(a)) {
    console.log('WARN not found:', a);
    continue;
  }
  s = s.replace(a, b);
}

// 3) 这个函数的文档注释里提到过类型，顺手改签名说明
s = s.replace(
  "    /// 这种类型默认带哪些字段标签（只有内置类型有模板）。",
  "    /// 这种类型默认带哪些字段（只有内置类型有模板）。",
);

// 4) builtin_template 解构三元组
s = s.replace(
  "        .map(|(label, secret)| FieldTemplate {" + NL +
  "            label: (*label).to_string()," + NL +
  "            secret: *secret," + NL +
  "        })",
  "        .map(|(label, secret, hint)| FieldTemplate {" + NL +
  "            label: (*label).to_string()," + NL +
  "            secret: *secret," + NL +
  "            hint: (*hint).to_string()," + NL +
  "        })",
);

fs.writeFileSync(p, s, 'utf8');
console.log('done');
