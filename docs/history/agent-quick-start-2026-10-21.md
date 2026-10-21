# Archived agent quick start

Historical snapshot from the README at `0a4ab863`, archived on 2026-10-21. Tool
activation states and historical PR references below are not current setup
instructions. Start with [AGENTS.md](../../AGENTS.md) and the
[current task workflow](../development/task-workflow.md) for active guidance.

## 代理协作工作流（Owner 快速开始）

日常任务由 Claude
Code 与 Codex 交替执行；两者按任务和角色互换，不按工具划分工作流。规则只有一份：根
`AGENTS.md`（Claude Code 通过根 `CLAUDE.md` 的 `@AGENTS.md`
导入）、共享的任务工作流 `docs/development/task-workflow.md`（由 PR
#118 引入）与三个技能的正文
`.agents/skills/yoyi-{task,review,handoff}/SKILL.md`； `.claude/skills/`
只是渲染同一正文的薄适配层。

| 想做的事                           | Claude Code                                             | Codex                                                   |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| 只分析、不改动                     | `/yoyi-task plan <request>`                             | `$yoyi-task plan <request>`                             |
| 执行已批准任务（或足够明确的请求） | `/yoyi-task start #<issue>`                             | `$yoyi-task start #<issue>`                             |
| 变更需求                           | `/yoyi-task change #<issue> <delta>`                    | `$yoyi-task change #<issue> <delta>`                    |
| 只看状态                           | `/yoyi-task status #<issue>`                            | `$yoyi-task status #<issue>`                            |
| 独立审查                           | `/yoyi-review <PR>`                                     | `$yoyi-review <PR>`                                     |
| 交接 / 接手                        | `/yoyi-handoff save` · `/yoyi-handoff resume <task-id>` | `$yoyi-handoff save` · `$yoyi-handoff resume <task-id>` |

可复制的英文示例：

```text
/yoyi-task plan <one-sentence request: goal, surface, explicit non-goals>
/yoyi-task start #<issue>
/yoyi-task change #<issue> <what changes; everything else stays as approved>
/yoyi-review <pr>
/yoyi-handoff save
```

`#<issue>` 是任务的 Issue 编号（任务规格），`<pr>` 是 Pull
Request 编号（实际改动与证据）；两者不是同一个数字。

信息只有一个来源：GitHub Issue（`Task`
模板）是任务规格；`docs/project-status.md`
是项目级状态；PR 与验证产物是实际改动与证据；本机路径、进程与详细交接只写在
`~/Developer/artifacts/moya-inscriptions-web/<task-id>/`，从不入库。看板只用 Ideas
/ Ready / Doing / Review /
Done 五种状态。默认同时只有一个主要实现任务，最多两个真正独立的写入者（通常一个 Web、一个 Apple）；等待审查也算未完成。

工具能力与激活（本机）：

| 项目                                                     | 状态               | 说明                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex skills（`.agents/skills`）                         | 新会话生效         | 工作树包含合并后的文件后，新启动的 Codex 会话加载；`codex debug prompt-input` 可核对已加载的规则与 skills                                                                                            |
| Claude skills（`.claude/skills`）                        | 会话内自动重新加载 | 已存在的 skills 目录中的改动在当前会话内生效，`/reload-skills` 可手动重新扫描；`/context` 查看已加载内容。`yoyi-review` 只能由用户调用（`/yoyi-review <pr>`）                                        |
| Claude 项目权限（`.claude/settings.json`）               | `allow` 需信任目录 | `deny` 与 `ask` 规则立即生效；`allow` 规则只在该目录已被信任后生效。日常提交与推送只自动放行 `node scripts/task-git.mjs` 的两个固定操作；原始 `git commit` / `git push` 从不自动放行                 |
| Claude PreToolUse 钩子（`.claude/hooks/guard-bash.mjs`） | 便利层             | 交互会话在接受信任后运行，`-p` / SDK 会话直接运行；只把两类命令（对 `yoyi_dev` 的破坏性 SQL、`git -C … push` 的强推或推 main）改为直接拒绝。钩子无法启动时，命令仍由原生规则决定，不会因此被自动放行 |
| Claude 项目 MCP（`.mcp.json`）                           | 当前不存在         | 只有 Draft PR #124（Development 试点，默认关闭）合并后才出现；交互会话首次需批准，`-p` / SDK 会话会直接连接其中的服务器而不询问；`claude mcp reset-project-choices` 重置交互选择                     |

GitHub 记录与云工具：Issue 评论、正式 PR 审查和 `gh pr edit`
需要确认；当前任务 PR 的评论（先做出站凭据检查）自动放行；这些记录都不构成新的 Owner 授权，除非记录的是 Owner 明确的任务、变更或审查指令。Production 与云工具（如
`tcb`、`tccli`、`cloudbase`、`coscli` 与 CloudBase
MCP）从不自动放行：必须先由当前任务明确授权具体操作（账号与资源范围、读写边界、费用边界、交付停止点），再确认原生询问；确认只针对这一次调用，不产生 Production 授权，也不扩大任务。普通任务不得为了得到询问而调用云命令，应停止并报告范围冲突。

激活与回滚（按依赖关系）：

- 这些文件随 `main` 分发，但"文件已合并"不等于"已激活"：Codex
  skills 在新会话中加载，Claude
  skills 在会话内自动重新加载（回滚同样立即影响正在运行的 Claude 会话）；`allow`
  规则需要信任目录；已有会话必须显式重新读取规则（见任务工作流）。
- 已有任务工作树不会自动获得更新。由该任务的写入者在安全的检查点（先提交或
  `yoyi-handoff save`）把 `origin/main`
  合并进任务分支；合并可能与本地改动冲突，需要人工解决，不自动处理，也不 reset /
  stash / 重建分支。
- 依赖顺序：任务路由与共享工作流（PR #118）在先；测试目标守卫（Issue #119 / PR
  #122）与任务生命周期（Issue #120 / PR
  #123）依赖它的分类器映射。回滚时先还原后合入的改动；`git revert`
  只恢复被跟踪的代码，不会撤销本机的目录信任、激活时以“Yes, don’t ask
  again”保存到 `.claude/settings.local.json`
  的规则、已批准的 MCP 服务器、OAuth 范围、私有产物或看板状态。Issue、任务历史与工作树不作为清理自动删除；用户全局配置从未被修改。
