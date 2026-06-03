---
name: coffee-roaster-workflow
description: Use when 修改或改进咖啡烘焙机控制软件项目时触发。Triggers on: update coffee roaster, modify roaster code, fix roaster bug, add roaster feature, improve roasting UI, change roast profile, update hardware driver, coffee roaster project change, 烘豆机, 咖啡烘焙机, 烘焙曲线, TC4S, 树莓派.
---

# 咖啡烘焙机工作流

通过编排专业子代理（subagent）开发运行在树莓派 4B 上的热风咖啡烘焙机控制软件。**主上下文只做编排**——读文档、写代码、审查、验证、改文档全部派遣 subagent。这样既保护主上下文不被工具输出污染，又能放大并行度并让每个环节获得专业角色边界。

本 skill 是 **superpowers** 工作流体系的领域扩展。执行任何阶段前，遵循 `superpowers:using-superpowers` 的指令优先级：如有更具体的 superpowers skill 适用，必须先调用。superpowers 技能覆盖默认行为的地方，以 superpowers 为准；用户显式指令（CLAUDE.md、直接请求）始终最高优先。

## 核心原则：Subagent-first

每一个有产出的工作环节都派遣专门的 subagent 执行。主上下文只负责：

- 任务分解
- 子代理派发与提示词组装
- 状态跟踪与跨代理协调
- 用户沟通

**主上下文不应亲自做：** 探索式扫描代码、编写大段代码、运行测试、撰写 UPDATE_LOG、调试 bug、跨文件代码审查。这些工作一律派遣对应类型的 subagent（Explore / general-purpose / Plan）。

**唯一例外**：极轻量、单点、可一两个 Read+Edit 完成的改动（例如修一个错别字、改一行常量），主上下文可直接处理。任何超过这个阈值的工作必须派遣 subagent。

## 项目背景（subagent 必读）

- **后端**：Python 3.10+、FastAPI、WebSocket、asyncio、Pydantic v2、SQLite（aiosqlite）
- **前端**：原生 HTML/CSS/JS、Chart.js 4.4.1、深色工业风 UI
- **硬件**：树莓派 4B、TC4S 温控器、USB-RS485 Modbus RTU（`/dev/ttyUSB0`）、pyserial-asyncio-fast
- **项目根目录**：`roaster/`，包含 `main.py`、`config.yaml`、`src/`、`static/`、`data/`
- **当前版本**：从 `roaster/UPDATE_LOG.md` 读取

## 可用 prompt 资源（按需加载）

`./prompts/` 目录下放置了 6 个**项目专属代理 prompt**，用于在派发子代理时统一传达项目规则与输出格式。**这些 prompt 是工具，不是义务**——任务足够具体、约束清晰时，可以直接在 dispatch 提示中写明要求；任务复杂、需要批量传达项目规则（深色工业风、PITFALLS 强制阅读、寄存器文档要求等）时，加载对应 prompt 能节省主上下文并保证规则不遗漏。

| Prompt 文件 | 角色 | 何时加载 | 何时跳过 |
|------------|------|---------|---------|
| `./prompts/frontend-dev.md` | 前端开发 | 跨文件 UI 改动、需要项目规则提醒（深色工业风、Chart.js 陷阱清单、API 一致性约束） | 单点小改、所有规则已在 dispatch 中说明 |
| `./prompts/backend-dev.md` | 后端开发 | 触及 async/Modbus/Pydantic 模型、需要硬件通信健壮性约束清单 | 单一函数注释、纯文档式改动 |
| `./prompts/hardware-dev.md` | 硬件开发 | 修改寄存器映射、串口时序、CRC、重连逻辑 | 不涉及 `tc4s_async.py` 的改动 |
| `./prompts/reviewer.md` | 代码审查 | 改动跨多文件、需要标准化的「死代码 / 一致性 / 错误处理」审查输出 | 改动只 1-2 处时仍需派遣 Reviewer subagent，但可省略 prompt |
| `./prompts/verifier.md` | 验证员 | 涉及状态机、ROR、硬件安全、用户的 9 条要求齐验 | 纯文档改动、纯样式微调时仍需派遣 Verifier subagent，但可省略 prompt |
| `./prompts/updater.md` | 文档更新员 | UPDATE_LOG / README / PITFALLS 任意一项需要追加 | 无文档改动需要 |

**加载方式**：在 Agent dispatch 的 prompt 字段开头插入 `请先阅读 ./prompts/<role>.md 作为你的角色规则与输出格式约定。然后执行下列任务：` 即可。也可以由主上下文先 Read 一次再把要点摘录进 dispatch（更省 token，但失去 prompt 文件升级时的同步性）。

**默认偏好**：复杂任务（≥ 2 个文件 / ≥ 2 个领域 / 需要项目规则） → 加载 prompt；简单任务（单文件、明确指令） → 跳过 prompt 但仍派遣 subagent。模板位于 `./templates/update-log-entry.md`，被 `updater.md` 引用。

## 工作流程

### 第一阶段：档案探索（Explore Subagent — 强制）

**派遣** Explore 类型 subagent 并行读取以下文档，返回结构化摘要：

1. `roaster/UPDATE_LOG.md` — 当前版本号 + 最近 1-2 个版本的关键改动
2. `roaster/README.md` — 项目结构关键路径
3. `roaster/PITFALLS.md` — 已知坑点摘要（标题级别 + 与本次请求相关项）

**为何派遣 subagent**：三份文档合计可能数千行，主上下文只需要摘要而非原文。Explore agent 是只读模式，正适合此场景。如 `PITFALLS.md` 缺失，subagent 应返回该信息以便后续创建。

### 第二阶段：需求分析与任务拆分（编排）

这是**编排工作**，由主上下文执行。结合 Explore subagent 返回的项目摘要分析用户请求，判断涉及哪些领域：前端、后端、硬件，或仅文档。

- **若请求复杂**（涉及 2+ 领域或需要设计决策）：
  1. 调用 **superpowers:brainstorming** 进行设计探索，产出带约束和接口定义的设计文档。
  2. 调用 **superpowers:writing-plans** 将设计转化为带依赖关系的实现计划。
  3. **派遣 Plan subagent** 起草具体实现步骤（独立计划文件），主上下文只审阅与签署。
- **若请求简单**（单一领域、边界清晰）：
  直接拆分为独立任务列表，标记可并行项。

### 第三阶段：并行实现（Implementation Subagents — 强制）

为每个独立任务派遣**全新的 general-purpose subagent**。**不允许主上下文亲自写代码**——即使是单文件改动，也派遣 subagent（除非命中「核心原则」中的极轻量例外）。

**并行派发原则（遵循 superpowers:dispatching-parallel-agents）：**

1. **识别独立域** — 按问题域分组（前端 / 后端 / 硬件）
2. **创建聚焦任务** — 每个代理获得单一领域、明确目标、约束边界
3. **并行派发** — 无共享文件的独立任务同时派遣（同一消息内多次 Agent 调用）
4. **回审整合** — 检查变更冲突

**每个实现 subagent 执行时（遵循 superpowers:subagent-driven-development）：**

- **前端任务**：subagent 加载**最适合的前端 skill**（如 `ui-ux-pro-max` 或项目自定义前端 skill）。如任务复杂或涉及多文件 UI 改动，加载 `./prompts/frontend-dev.md` 作为角色规则；简单单点改动可跳过 prompt 但仍派遣 subagent。
- **后端任务**：如任务触及 async/Modbus/Pydantic 模型或需要硬件通信健壮性约束，加载 `./prompts/backend-dev.md`；纯文档式或单函数级改动可跳过 prompt 但仍派遣 subagent。
- **硬件任务**：如改动涉及寄存器映射、串口时序、CRC、重连逻辑，加载 `./prompts/hardware-dev.md`；不触及 `tc4s_async.py` 的改动可跳过 prompt 但仍派遣 subagent。

等待所有实现 subagent 返回。状态处理（遵循 superpowers:subagent-driven-development）：

- **DONE**：进入审查阶段。
- **DONE_WITH_CONCERNS**：读取顾虑。如涉及正确性或范围问题，在审查前回退处理；如是观察性意见，记录后继续。
- **NEEDS_CONTEXT**：提供缺失上下文后重新派遣。
- **BLOCKED**：评估阻塞原因。提供更多上下文、更强模型、更小范围，或升级给人工处理。

**⚠️ BUG 处理（强制 superpowers:systematic-debugging + Debug Subagent）：**
任何实现代理报告 bug、测试失败或异常行为时，**立即停止并派遣专门的 Debug subagent**（general-purpose 类型）按 superpowers:systematic-debugging 四阶段流程（根因调查 → 模式分析 → 假设验证 → 实现修复）处理。**禁止主上下文亲自调试**；禁止在没完成 Phase 1 根因调查前提出修复方案。

### 第四阶段：交叉审查（Reviewer Subagent — 强制）

派遣 **Reviewer subagent**（Explore 类型，只读审查），调用 **superpowers:requesting-code-review** 的审查模板和流程，审查所有改动文件。如改动跨多文件或需要标准化输出，加载 `./prompts/reviewer.md`；改动只 1-2 处时也仍须派遣 subagent，但可省略 prompt 加载。

审查维度：

1. 需求符合性 — 实现是否完整，有无过度设计
2. 代码清理 — 无死代码、无用导入、废弃的 CSS/JS 函数
3. 一致性 — 前后端 API 契约是否对齐，命名风格是否统一
4. 错误处理 — 特别是硬件通信的超时和重试
5. 性能 — 无阻塞 async 调用，无过度 DOM 操作

如审查发现问题：退回原实现 subagent 修复（**不可由主上下文修复**），然后重新派遣 Reviewer。审查未通过前不得继续。

### 第五阶段：自检验证（Verifier Subagent — 强制）

**铁律 — 先调用 superpowers:verification-before-completion：**
在声称任何阶段完成前，必须先运行验证命令并读取完整输出。无 fresh 验证证据，不得声称验证通过。

派遣 **Verifier subagent**（Explore 类型只读核对，或 general-purpose 类型若需执行命令）。涉及状态机、ROR、硬件安全或需要复核用户的 9 条要求时，加载 `./prompts/verifier.md` 锁定核验清单：

1. 用户的 9 条要求是否全部满足（专业前端、专业后端、读取更新记录、实现需求、自检、更新 UPDATE_LOG.md、完整清理 + README 更新、树莓派环境意识、记录坑点）
2. 逻辑合理性 — 是否引入新 bug
3. 回退风险 — 现有功能（ROR 计算、状态机、WebSocket 推送）是否保持完好
4. 硬件安全性 — 改动是否可能损坏设备或中断通信
5. 文档状态 — UPDATE_LOG、README、PITFALLS 是否需要更新？

如验证发现问题：退回实现 subagent 修复（**不可由主上下文修复**），然后重新派遣 Reviewer + Verifier。
**无 fresh 验证证据，不得声称验证通过。**

### 第六阶段：文档更新（Updater Subagent — 强制）

验证通过后，派遣 **Updater subagent**（general-purpose 类型）执行。加载 `./prompts/updater.md` 以保持现有文档格式与版本号规则：

1. 按照现有格式在 `roaster/UPDATE_LOG.md` 追加新版本条目
2. 如架构/结构变化，更新 `roaster/README.md`
3. 如实现过程中发现新坑点，更新或创建 `roaster/PITFALLS.md`

更新完成后**再次派遣 Verifier subagent** 确认文档格式正确（**不允许主上下文亲自核对**）。

### 第七阶段：最终汇报与收尾（编排）

这是**编排工作**，由主上下文执行。汇总所有 subagent 的返回向用户报告：

- 版本提升（如 v3.7 → v3.8）
- 改了什么、为什么改
- 修改了哪些文件
- 任何遗留问题或下一步
- 询问用户是否继续或调整

如本次工作涉及 git 分支，调用 **superpowers:finishing-a-development-branch** 完成合并 / PR / 清理。

## 子代理角色映射

| 角色 | 推荐 agent type | 对应本地 prompt（可选） | 职责 | 备注 |
|------|----------------|------------------------|------|------|
| 档案探索员 | Explore | — | Phase 1 读取 UPDATE_LOG / README / PITFALLS | 必派遣，节省主上下文 |
| 设计师 | Plan | — | Phase 2 复杂任务起草实现计划 | 仅复杂任务派遣 |
| 前端开发 | general-purpose | `./prompts/frontend-dev.md` | HTML/CSS/JS 实现 | 可同时加载 ui-ux-pro-max skill |
| 后端开发 | general-purpose | `./prompts/backend-dev.md` | Python/FastAPI 实现 | 聚焦 async、API、数据层 |
| 硬件开发 | general-purpose | `./prompts/hardware-dev.md` | Modbus/串口/GPIO 改动 | 聚焦健壮性、超时、重试 |
| Debug | general-purpose | — | bug 出现时的根因调查与修复 | 强制走 systematic-debugging 四阶段 |
| 审查员 | Explore | `./prompts/reviewer.md` | 代码质量与清理 | 只读审查；建议最强模型 |
| 验证员 | Explore / general-purpose | `./prompts/verifier.md` | 逻辑与需求检查 | 扮演项目维护者；建议最强模型 |
| 文档更新员 | general-purpose | `./prompts/updater.md` | 文档维护 | 保留现有格式 |

## 执行前检查清单

- [ ] 已派遣 Explore subagent 读取 `roaster/UPDATE_LOG.md` 获取当前版本
- [ ] 已通过 Explore subagent 摘要了解当前结构
- [ ] 已通过 Explore subagent 读取或记录缺失的 `roaster/PITFALLS.md`
- [ ] 已识别请求涉及哪些领域（前端/后端/硬件）
- [ ] 已判断任务可并行还是需串行
- [ ] 已规划每个工作环节由哪类 subagent 执行（Explore / Plan / general-purpose）

## 执行后检查清单

- [ ] Reviewer subagent 已批准所有改动
- [ ] Verifier subagent 已确认 9 条用户要求全部满足
- [ ] Updater subagent 已追加 `roaster/UPDATE_LOG.md` 新版本条目
- [ ] Updater subagent 已更新 `roaster/README.md`（如结构变化）
- [ ] Updater subagent 已更新 `roaster/PITFALLS.md`（如新坑点）
- [ ] 死代码已清除（由 Reviewer subagent 确认）
- [ ] 文档更新后 Verifier subagent 已二次核验格式
- [ ] 已向用户交付变更摘要

## 环境说明

**开发环境**：Windows（用户的对话电脑）。**运行环境**：树莓派 4B（Raspberry Pi OS）。

- 不要在 Windows 上执行 `python3 main.py`、串口命令、GPIO 命令或任何硬件交互命令。
- 静态代码分析和文件编辑在 Windows 上可以正常进行。
- 任何需要树莓派运行时的命令必须标注为"需要在树莓派上测试"，而非直接执行。
- 编辑 Python 文件时注意：代码运行在 Linux 路径下（`/dev/ttyUSB0`），尽管编辑发生在 Windows 上。

## 依赖 skill

### Superpowers 核心体系（必用）

- **superpowers:using-superpowers** — 核心框架。执行本 skill 的任何阶段前，必须先检查是否有更具体的 superpowers skill 适用。
- **superpowers:brainstorming** — 复杂需求或需要设计决策时，必须先调用进行设计探索。
- **superpowers:writing-plans** — 需要生成详细实现计划时调用，可配合 Plan subagent 输出独立计划文件。
- **superpowers:dispatching-parallel-agents** — 并行派发实现代理时，遵循其独立域识别、聚焦提示、冲突检查原则。
- **superpowers:subagent-driven-development** — 单任务实现时遵循其两阶段审查流程（spec compliance → code quality）。
- **superpowers:systematic-debugging** — 任何实现代理遇到 bug、测试失败或异常行为时，必须强制调用并派遣专门的 Debug subagent。
- **superpowers:requesting-code-review** — 交叉审查阶段调用其审查模板和流程，由 Reviewer subagent 执行。
- **superpowers:verification-before-completion** — **铁律**：任何阶段在声称完成前，必须运行验证命令并出示证据。无验证不得声称完成。
- **superpowers:finishing-a-development-branch** — 最终收尾时调用（如需要 git 合并/PR）。

### 前端技能（策略化选择）

- **ui-ux-pro-max** 或项目自定义前端 skill — 前端 subagent 根据具体需求选择最适合的前端 skill，不强制绑定单一技能。

### 项目专属 prompt（按需加载，非强制）

位于 `./prompts/` 下的 6 份角色 prompt（`frontend-dev` / `backend-dev` / `hardware-dev` / `reviewer` / `verifier` / `updater`），用于在 dispatch 子代理时统一传达项目规则与输出格式。**与 superpowers skill 是协作关系而非替代**：superpowers 提供方法论（如 systematic-debugging 四阶段、verification-before-completion 铁律），prompts 提供项目语境（深色工业风、TC4S 寄存器约束、UPDATE_LOG 格式等）。加载策略详见上方「可用 prompt 资源」一节。

## 红线警告

- **绝不可让主上下文亲自做具体工作** —— 探索代码、写大段代码、跑测试、写 UPDATE_LOG、调试 bug 一律派遣 subagent
- 绝不可跳过 Phase 1 档案探索 subagent —— 没有项目摘要不得开始任何改动
- 绝不可跳过审查员或验证员阶段
- 绝不可让主上下文亲自审查或验证 —— 审查与验证必须由独立 subagent 完成（避免「写代码的人审自己」的盲点）
- 绝不可并行派遣多个编辑同一文件的实现 subagent
- 绝不可让实现 subagent 在 Windows 上执行硬件命令
- 绝不可遗留死代码 —— Reviewer subagent 必须确认清理完毕
- 绝不可在代码审查和验证通过前更新文档
- 绝不可忽视 subagent 的 DONE_WITH_CONCERNS 或 BLOCKED 状态
- **绝不可跳过 superpowers:verification-before-completion —— 无验证不得声称完成**
- **绝不可在 superpowers:systematic-debugging 完成 Phase 1 根因调查前提出修复方案**
- **绝不可在主上下文亲自调试 bug —— bug 出现立即派遣专门的 Debug subagent**
- 绝不可在声称完成前未运行验证命令
