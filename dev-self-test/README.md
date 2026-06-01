# dev-self-test

一个 Claude Code skill，引导开发者在提测 / 合并 / 发版前完成标准化自测，并产出可审计的归档文档。

## 目录

- [解决什么问题](#解决什么问题)
- [安装](#安装)
- [怎么用](#怎么用)
- [4 件套产出](#4-件套产出)
- [文件结构](#文件结构)
- [反馈](#反馈)

## 解决什么问题

| 之前 | 引入后 |
|---|---|
| "你自测过吗？" "测过了" — 口头无依据 | 每次自测产出 README，结论 + 上线决策一处可见 |
| 跑测发现的 bug 散在 commit / 聊天 / 个人记忆 | `defects.md` 单一档案，BUG 编号 + 优先级 + 修复 commit 可追溯 |
| "功能跑通就 PASS" 漏放日志 / 告警维度生产风险 | 强制 4 维度判定（数据 / 返回 / 日志 / 告警），漏写日志当场判 FAIL |
| 不同人自测形态各异 | 全团队 / 跨项目一致形态，reviewer 无学习成本 |

## 安装

仓库根目录下用 symlink 方式装入全局 skills（修改仓库代码会即时生效）：

```bash
ln -s $(pwd)/dev-self-test ~/.claude/skills/dev-self-test
```

或者直接拷贝（独立副本，不跟仓库同步）：

```bash
cp -r dev-self-test ~/.claude/skills/dev-self-test
```

装完后，任何项目里只要触发关键词命中（"自测" / "提测前" / "测试计划" / "回归测试" / "发版前自测" 等），AI 都会自动加载本 skill。

## 怎么用

skill 按 4 步流程工作：

1. **开测前准备** — agent 逐项询问 4 类输入文档（PRD / 技术方案 / use-case / 已有用例）和观测工具（推荐 `mycli` 查 MySQL、`observability-skills` 查日志），生成 `README.md` 自测依据段
2. **写 plan + 代码预审** — agent 按场景拆分写 `plan.md`，每个分支按 4 维度严格预期落地；写完后 dispatch 一个 subagent walkthrough 代码，**测前发现 P0 bug** 登记到 `defects.md`，修完再开测
3. **跑测试 + 写 round_N.md** — 每个分支按 4 维度（数据 / 返回 / 日志 / 告警）展开实证；FAIL 立即修复并重测，留前后对照
4. **维护 defects + 填 README 自测结论** — 4 件套交付：feature 总入口 + 场景测试计划 + 跑测记录 + 缺陷档案

## 4 件套产出

每个 feature 自测产出 4 类文件，职责单一不重叠：

| 文件 | 内容 | 谁看 |
|---|---|---|
| `README.md` | feature 级入口：自测结论 + 自测依据 + 上线决策 | reviewer / leader |
| `plan.md` | 场景测试计划：基础测试（5 子类）+ 业务测试 | plan 编写者 / reviewer |
| `round_N.md` | 第 N 轮执行记录：实际入参 + 4 维度证据 + 修复 commit | 自测人 / reviewer |
| `defects.md` | 缺陷档案 single source of truth：BUG 编号 + 优先级 + 状态 | reviewer / leader |

路径规则：

- 单场景：`docs/dev-self-test/{branch}/{README,plan,round1,defects}.md`
- 多场景：`docs/dev-self-test/{branch}/README.md` + `docs/dev-self-test/{branch}/{scene}/{plan,round1,defects}.md`

## 文件结构

```
dev-self-test/
├── README.md                  # 本文档（项目门面）
├── SKILL.md                   # skill 主文档（agent 加载）
└── templates/
    ├── readme-template.md     # README.md 真实样例
    ├── plan-template.md       # plan.md 真实样例
    ├── round-template.md      # round_N.md 真实样例
    └── defects-template.md    # defects.md 真实样例
```

## 反馈

skill 在使用中如发现规则缺失 / 措辞含糊 / 跨项目兼容性问题，欢迎在仓库提 issue 或直接修改 `SKILL.md` 后提交 MR。

skill 本身用 RED-GREEN-REFACTOR 方式开发：让无 skill 的 subagent 盲测产出违规作为基线，再让 reviewer 读优化后 SKILL 验证规则覆盖度。新增规则建议附测试场景。
