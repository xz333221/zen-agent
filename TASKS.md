# Zen Agent — 开发任务清单

> 本文件由 AI 维护，记录所有待开发任务。用户可以说「执行任务 T-001」来启动开发。

## 状态说明

| 状态 | 含义 |
|------|------|
| ⬜ TODO | 待开发 |
| 🔄 DOING | 开发中 |
| ✅ DONE | 已完成 |
| ⏸️ BLOCKED | 被阻塞 |

---

## P0 — 核心基础（必须完成）

### T-001: LLM Provider 抽象层与真实对话接入
- **状态**: ✅ DONE
- **描述**: 当前 `IPC_CHANNELS.CHAT_SEND` 返回模拟响应。需要实现真实的 LLM 调用，支持 OpenAI 兼容 API。
- **涉及文件**:
  - `src/main/ipc/index.ts` — 替换 `CHAT_SEND` handler 中的模拟逻辑
  - 新建 `agent/providers/llm-provider.ts` — LLM 调用抽象
  - 新建 `agent/providers/llm-config.ts` — Provider 配置管理
- **验收标准**:
  - [ ] 支持 OpenAI 兼容 API（baseURL + apiKey + model）
  - [ ] 流式输出通过 `CHAT_RESPONSE_CHUNK` 发送到渲染进程
  - [ ] 错误处理：网络错误、API 限流、无效 key
  - [ ] 可通过系统配置 IPC 设置 provider
- **E2E 测试**: 发送消息后收到真实 LLM 回复（mock 模式下验证流式 chunk 数 > 0）

### T-002: SQLite 持久化存储（会话 + 消息）
- **状态**: ✅ DONE
- **描述**: 使用 sql.js 实现 SQLite 本地存储，保存会话历史和消息记录。
- **涉及文件**:
  - 新建 `src/main/storage/database.ts` — 数据库初始化与迁移
  - 新建 `src/main/storage/repositories/sessions.ts` — 会话 CRUD
  - 新建 `src/main/storage/repositories/messages.ts` — 消息 CRUD
  - `src/main/ipc/index.ts` — 接入 `CHAT_LOAD_HISTORY`、`CHAT_NEW_SESSION`
- **验收标准**:
  - [ ] 数据库文件存储在 `app.getPath('userData')/zen-agent.db`
  - [ ] 自动建表（sessions, messages）
  - [ ] 新建会话时写入数据库
  - [ ] 发送消息后持久化用户消息和 Agent 回复
  - [ ] `CHAT_LOAD_HISTORY` 返回真实历史记录
- **E2E 测试**: 发送消息 → 关闭对话窗口 → 重新打开 → 历史消息可见

### T-003: Agent ReAct 循环实现
- **状态**: ✅ DONE
- **描述**: 实现 Think-Act-Observe 循环，支持多步推理和工具调用。
- **涉及文件**:
  - `agent/core/agent-loop.ts` — 完善 ReAct 循环
  - 新建 `agent/core/intent-parser.ts` — 意图解析
  - 新建 `agent/core/action-executor.ts` — 动作执行
  - 新建 `agent/core/reflection.ts` — 反思模块
- **验收标准**:
  - [ ] 支持 ReAct 格式的 LLM 输出解析
  - [ ] 每一步通过 `CHAT_TRACE_STEP` 发送到渲染进程
  - [ ] 循环结束后通过 `CHAT_TRACE_COMPLETE` 发送完整追踪
  - [ ] 最大循环次数限制（默认 10）
  - [ ] 超时和异常处理
- **E2E 测试**: 复杂问题触发多步推理 → 执行追踪 UI 显示步骤

### T-004: 系统配置面板
- **状态**: ✅ DONE
- **描述**: 创建设置面板，允许用户配置 LLM Provider、API Key、模型选择等。
- **涉及文件**:
  - 新建 `src/renderer/settings/index.html` — 设置面板入口
  - 新建 `src/renderer/settings/App.vue` — 设置面板 UI
  - 新建 `src/main/windows/settings-window.ts` — 设置窗口
  - 新建 `src/preload/settings.ts` — 设置 preload
  - `src/main/ipc/index.ts` — 完善 `SYS_GET_CONFIG`、`SYS_SET_CONFIG`
- **验收标准**:
  - [ ] 可配置 Provider（OpenAI / 自定义 baseURL）
  - [ ] API Key 输入（密码框，存储加密）
  - [ ] 模型选择（gpt-4o, gpt-4o-mini 等）
  - [ ] Max Tokens 滑块
  - [ ] 配置持久化到本地文件
- **E2E 测试**: 打开设置 → 填写配置 → 保存 → 重启后配置仍在

### T-005: 上下文管理（Token 预算 + 滑动窗口）
- **状态**: ✅ DONE
- **描述**: 实现上下文窗口管理，包括 Token 计数、预算分配、滑动窗口和渐进式摘要。
- **涉及文件**:
  - 新建 `agent/utils/token-counter.ts` — Token 计数器（CJK + ASCII 混合估算）
  - 新建 `agent/core/summarizer.ts` — 渐进式摘要（LLM + 规则双模式，增量更新）
  - 新建 `agent/core/context-manager.ts` — 上下文管理器（预算分配 + 滑动窗口 + 会话级缓存）
  - `agent/core/agent-loop.ts` — 集成上下文管理器，替换手动 slice + 升级 Token 统计
- **完成内容**:
  - [x] 准确计算消息 Token 数（CJK ~0.7 token/字, ASCII ~0.25 token/字符, 消息开销）
  - [x] 超出预算时自动触发摘要压缩（compressionThreshold 或预算溢出触发）
  - [x] 保留最近 N 条消息完整，旧消息摘要（滑动窗口 + 会话级缓存增量更新）
  - [x] 系统提示词 + 摘要 + 历史 + 用户输入 = 总 Token 预算分配
  - [x] Token 统计步骤使用真实 Token 计数替代粗略估算
  - [x] LLM 不可用时回退为规则摘要（首尾消息 + 关键句提取）
- **E2E 测试**: 发送大量消息 → 验证旧消息被摘要、新消息保持完整

---

## P1 — 进化能力（核心差异化）

### T-006: 向量记忆系统（LanceDB）
- **状态**: ✅ DONE
- **描述**: 实现基于向量检索的长期记忆系统，支持语义搜索历史对话。
- **涉及文件**:
  - 新建 `agent/memory/embeddings.ts` — Embedding 生成（LLM + 伪嵌入回退 + LRU 缓存）
  - 新建 `agent/memory/vector-store.ts` — 向量存储（SQLite + 余弦相似度检索）
  - 新建 `agent/memory/memory-manager.ts` — 记忆管理器（存储/检索/去重/合并）
  - `src/main/storage/database.ts` — 添加 memories 表 + 索引
  - `agent/core/agent-loop.ts` — 接入 stepMemoryRetrieval + stepStore
- **完成内容**:
  - [x] 对话结束时自动生成 Embedding 并存储（含去重检测）
  - [x] 新对话开始时检索相关记忆（向量语义搜索 + 综合评分排序）
  - [x] 支持按时间、重要性、相关度排序（vectorScore * 0.5 + recencyScore * 0.2 + importanceScore * 0.3）
  - [x] 记忆去重和合并（余弦相似度 > 0.92 自动合并）
  - [x] LLM 未配置时使用确定性哈希伪嵌入（功能测试可用）
  - [x] 检索到的记忆自动注入 LLM 上下文（作为 system 消息）
  - [x] 记忆检索结果在执行追踪 UI 中展示
- **实现说明**: 使用 SQLite + 内存余弦相似度替代 LanceDB，避免原生模块依赖，适用于桌面应用规模
- **E2E 测试**: 对话 A 提到事实 → 新对话 B 相关问题 → Agent 引用 A 的内容

### T-007: 技能生成系统
- **状态**: ✅ DONE
- **描述**: 检测重复模式，自动生成可复用技能（Prompt 模板 + 工具链）。
- **涉及文件**:
  - 新建 `agent/evolution/pattern-detector.ts` — 模式检测（向量相似度 + 意图分类）
  - 新建 `agent/evolution/skill-generator.ts` — 技能生成（LLM + 规则双模式）
  - 新建 `agent/evolution/skill-store.ts` — 技能存储与匹配（向量检索 + 上下文注入）
  - 新建 `src/main/storage/repositories/skills.ts` — 技能 CRUD
  - `src/main/storage/database.ts` — 添加 skills 表 + 索引
  - `agent/core/agent-loop.ts` — 接入 stepSkillMatch + stepEvolution
- **完成内容**:
  - [x] 检测相同类型请求出现 3+ 次（向量相似度 >= 0.75 触发）
  - [x] 自动生成技能定义（名称、描述、Prompt 模板，LLM + 规则双模式）
  - [x] 技能存储到 SQLite（含嵌入向量用于匹配）
  - [x] 宠物显示 `evolving` 状态 + 进化通知（通过 onStateChange 回调）
  - [x] 后续请求自动匹配并使用已有技能（向量相似度匹配 + 上下文注入）
  - [x] 执行追踪展示技能匹配结果和进化事件
- **E2E 测试**: 重复 3 次相似请求 → 第 4 次自动使用技能 → 进化气泡出现

### T-008: Prompt 自适应优化
- **状态**: ✅ DONE
- **描述**: 基于用户反馈（正/负反馈、修改结果）自动优化系统 Prompt。
- **涉及文件**:
  - 新建 `agent/evolution/prompt-optimizer.ts` — Prompt 优化器（LLM + 规则双模式）
  - 新建 `agent/evolution/feedback-collector.ts` — 反馈收集（显式 + 隐式）
  - 新建 `src/main/storage/repositories/prompts.ts` — Prompt 版本管理 + 反馈记录
  - `src/main/storage/database.ts` — 添加 prompt_versions + feedback 表
  - `src/main/ipc/index.ts` — 添加 7 个新 IPC 通道
  - `src/preload/chat.ts` — 暴露反馈和 Prompt 管理 API
  - `src/shared/types.ts` — 新增 IPC_CHANNELS
  - `agent/core/agent-loop.ts` — 接入 stepPromptOptimization
- **完成内容**:
  - [x] 记录用户对回复的隐式反馈（复制=正, 修改=负, 忽略=中性）
  - [x] 支持 👍/👎 显式反馈（通过 IPC FEEDBACK_RECORD）
  - [x] 负反馈触发 Prompt 优化（阈值 3 次，自动触发 stepPromptOptimization）
  - [x] Prompt 版本管理（创建、回滚、查看所有版本）
  - [x] A/B 测试不同 Prompt 版本（setABTest/concludeABTest）
  - [x] LLM 驱动的深度优化 + 规则兜底快速优化
  - [x] 初始化时自动创建默认 Prompt v1
  - [x] AgentLoop 自动检测并触发优化（stepPromptOptimization）
  - [x] 执行追踪展示优化事件
- **E2E 测试**: 对回复点 👎 → 后续相似请求回复质量提升

### T-009: 技能管理面板
- **状态**: ✅ DONE
- **描述**: 创建可视化的技能管理界面，查看、编辑、删除已生成的技能。
- **涉及文件**:
  - 新建 `src/renderer/skills/index.html` — 技能面板入口
  - 新建 `src/renderer/skills/App.vue` — 技能列表 + 编辑器
  - 新建 `src/renderer/skills/main.ts` — Vue 入口
  - 新建 `src/renderer/skills/styles/skills.css` — 样式
  - 新建 `src/main/windows/skills-window.ts` — 技能窗口
  - 新建 `src/preload/skills.ts` — 技能 preload
  - `src/shared/types.ts` — 添加 SKILL_* IPC 通道
  - `src/main/ipc/index.ts` — 添加 5 个技能 IPC handler
  - `src/main/tray.ts` — 启用技能管理菜单项
  - `electron.vite.config.ts` — 添加 skills preload/renderer 入口
  - 新建 `e2e/tests/skills-panel.spec.ts` — E2E 测试
- **完成内容**:
  - [x] 技能列表（卡片式展示，含统计栏、搜索、状态筛选）
  - [x] 查看技能详情（名称、描述、Prompt 模板、使用次数、成功率、创建/更新时间）
  - [x] 编辑技能 Prompt（弹窗编辑器，支持名称/描述/内容/状态修改）
  - [x] 删除技能（确认对话框）
  - [x] 手动创建新技能（含状态选择：活跃/草稿/禁用/拒绝）
  - [x] 技能状态切换（一键启用/禁用）
  - [x] 搜索和状态筛选功能
  - [x] 系统托盘菜单集成
- **E2E 测试**: 7 个测试用例全部通过（打开窗口、空列表、创建、编辑、删除、IPC 操作、搜索筛选）

### T-010: 记忆浏览面板
- **状态**: ✅ DONE
- **描述**: 创建记忆浏览界面，查看和管理 Agent 的记忆库。
- **涉及文件**:
  - 新建 `src/renderer/memory/index.html` — 记忆面板入口
  - 新建 `src/renderer/memory/App.vue` — 记忆列表 + 搜索
  - 新建 `src/renderer/memory/main.ts` — Vue 入口
  - 新建 `src/renderer/memory/styles/memory.css` — 样式
  - 新建 `src/main/windows/memory-window.ts` — 记忆窗口
  - 新建 `src/preload/memory.ts` — 记忆 preload
  - `src/shared/types.ts` — 添加 MEMORY_* IPC 通道 + MemoryItem 类型
  - `src/main/ipc/index.ts` — 添加 6 个记忆 IPC handler
  - `src/main/tray.ts` — 启用记忆浏览菜单项
  - `electron.vite.config.ts` — 添加 memory preload/renderer 入口
  - 新建 `e2e/tests/memory-panel.spec.ts` — E2E 测试
- **完成内容**:
  - [x] 记忆时间线展示（卡片式，按时间倒序）
  - [x] 语义搜索记忆（基于向量检索，支持关键词搜索）
  - [x] 查看记忆详情（ID、类型、创建/访问时间、重要性、置信度、来源、内容、动作、标签）
  - [x] 删除记忆（确认对话框）
  - [x] 手动添加记忆（支持类型、重要性滑块、标签）
  - [x] 记忆统计栏（总计/情景/语义数量）
  - [x] 类型筛选（全部/情景/语义）
  - [x] 系统托盘菜单集成
- **E2E 测试**: 7 个测试用例全部通过（打开窗口、空列表、添加、详情、删除、IPC 操作、类型筛选）

---

## P2 — 多 Agent 协作

### T-011: Coordinator Agent
- **状态**: ✅ DONE
- **描述**: 实现协调 Agent，负责任务分解和子 Agent 调度。
- **涉及文件**:
  - 新建 `agent/core/coordinator.ts` — 协调器
  - 新建 `agent/core/sub-agent.ts` — 子 Agent 基类
  - `agent/core/agent-loop.ts` — 集成协调器
  - `src/shared/types.ts` — 新增 PlanDetail、DelegateDetail、plan/delegate StepType
  - `agent/core/types.ts` — TaskResult 添加 error 字段
- **完成内容**:
  - [x] 复杂任务自动分解为子任务（LLM 驱动 + 规则回退双模式）
  - [x] 分配给合适的子 Agent（5 种内置类型: coder/researcher/writer/analyst/general）
  - [x] 汇总子 Agent 结果（LLM 汇总 + 规则汇总）
  - [x] 执行追踪展示 Agent 协作过程（plan + delegate 步骤）
  - [x] 共享黑板机制（子 Agent 间通过 Blackboard 传递依赖结果）
  - [x] 并行执行无依赖子任务（maxParallelTasks 控制）
  - [x] 依赖失败时自动跳过后续任务
- **E2E 测试**: 5 个测试用例全部通过（复杂请求触发 plan 步骤、规则分解、委派信息、Mock 模式、简单请求不触发）

### T-012: 内置工具集
- **状态**: ✅ DONE
- **描述**: 实现常用工具供 Agent 调用。
- **涉及文件**:
  - 新建 `agent/tools/calculator.ts` — 计算器（安全表达式求值 + 数学函数 + 常量）
  - 新建 `agent/tools/file-reader.ts` — 文件读取（编码检测 + 大小限制 + 行号显示）
  - 新建 `agent/tools/code-executor.ts` — 代码执行（沙箱 + 危险操作拦截 + 超时保护）
  - 新建 `agent/tools/web-search.ts` — 网络搜索（DuckDuckGo API + 模拟回退）
  - 新建 `agent/tools/tool-registry.ts` — 工具注册表（自动注册全部内置工具）
  - `src/main/ipc/index.ts` — 添加 TOOL_LIST、TOOL_EXECUTE IPC handler
  - `src/preload/chat.ts` — 暴露 getTools/executeTool API
  - `src/shared/types.ts` — 添加 TOOL_LIST、TOOL_EXECUTE IPC 通道
- **完成内容**:
  - [x] 每个工具有清晰的输入/输出 schema
  - [x] 工具执行结果通过 `CHAT_TRACE_STEP` 展示（Agent ReAct 循环集成）
  - [x] 工具执行有超时保护（各工具自定义 timeoutMs）
  - [x] 支持 Agent 自主选择工具（ReAct 格式解析）
  - [x] 计算器支持基本运算、三角函数、对数、常量（pi, e）
  - [x] 代码执行器阻止危险操作（require, process, fs 等）
  - [x] 文件读取器支持文件类型限制和大小限制
  - [x] 网络搜索使用 DuckDuckGo Instant Answer API
- **E2E 测试**: 13 个测试用例全部通过（工具注册、计算器运算/函数/常量/错误、文件读取/不存在、代码执行/危险拦截、网络搜索、不存在工具、API 方法、Schema 验证）

### T-013: 执行追踪 UI 完善
- **状态**: ✅ DONE
- **描述**: 完善执行追踪组件，支持实时展示和折叠查看。
- **涉及文件**:
  - 新建 `src/renderer/chat/components/LiveTrace.vue` — 实时追踪组件
  - `src/renderer/chat/components/ExecutionTrace.vue` — 完善实时追踪 + Plan/Delegate 渲染 + 复制按钮 + 动画
  - `src/renderer/chat/App.vue` — 接入实时 `TRACE_STEP` + 传递 liveSteps
  - `src/renderer/chat/stores/chat.ts` — 添加 liveSteps 状态和 addLiveStep 方法
  - `src/renderer/chat/components/ChatMessage.vue` — 集成 LiveTrace 组件
- **完成内容**:
  - [x] 实时展示每一步（Think/Act/Observe/Plan/Delegate）
  - [x] 4 层折叠（概要 → 步骤 → 详情 → 原始数据）
  - [x] 步骤间有动画过渡（TransitionGroup + CSS animation）
  - [x] 支持复制单步输出（copyStepOutput 函数 + 剪贴板 API）
  - [x] LiveTrace 组件在流式输出期间实时显示步骤
  - [x] Plan 步骤展示任务分解详情（子任务列表 + 状态 + 依赖关系）
  - [x] Delegate 步骤展示子 Agent 执行详情（结果 + 耗时 + Token）
  - [x] 步骤展开/折叠有 slideDown 动画
- **E2E 测试**: 9 个测试用例全部通过（实时追踪可见、展开/折叠、步骤详情展开/折叠、摘要信息、步骤类型完整性、步骤图标、状态指示器、汇总栏、LiveTrace 事件）

---

## P3 — 体验优化

### T-014: 系统托盘菜单完善
- **状态**: ✅ DONE
- **描述**: 完善系统托盘右键菜单，支持快速操作。
- **涉及文件**:
  - `src/main/tray.ts` — 托盘菜单（含休眠/唤醒状态管理）
  - `src/main/windows/pet-window.ts` — 右键菜单同步更新
  - `src/shared/types.ts` — 添加 `CHAT_NEW_SESSION_NOTIFY` IPC 通道
  - `src/preload/chat.ts` — 添加 `onNewSessionNotify` 监听
  - `src/renderer/chat/App.vue` — 监听新建会话通知
- **完成内容**:
  - [x] 打开对话 / 关闭对话
  - [x] 新建会话（通过 IPC 通知渲染进程）
  - [x] 打开技能管理
  - [x] 打开记忆浏览
  - [x] 打开设置
  - [x] 休眠 / 唤醒（状态切换 + 气泡提示 + 菜单动态更新）
  - [x] 退出
- **E2E 测试**: 4 个测试用例（休眠/唤醒状态切换、新建会话通知、右键菜单打开面板、托盘菜单存在）

### T-015: 宠物拖拽与位置记忆
- **状态**: ✅ DONE
- **描述**: 完善宠物拖拽体验，记住上次位置。
- **涉及文件**:
  - 新建 `src/main/window-state.ts` — 窗口状态管理（持久化 + 多显示器边界检查）
  - `src/main/windows/pet-window.ts` — 位置持久化集成
  - `src/renderer/pet/App.vue` — 拖拽优化（requestAnimationFrame 合并）
  - `src/preload/pet.ts` — 添加 `onDragEnd` 方法
  - `src/shared/types.ts` — 添加 `PET_DRAG_END` IPC 通道
- **完成内容**:
  - [x] 拖拽流畅无卡顿（requestAnimationFrame 合并多次拖拽事件，减少 IPC 通信频率）
  - [x] 位置保存到配置文件（window-state.json）
  - [x] 重启后恢复上次位置
  - [x] 多显示器支持（ensureVisibleBounds 检查位置是否在任何显示器可视范围内）
- **E2E 测试**: 4 个测试用例（初始位置、拖拽保存、DRAG_END 保存、多显示器边界检查）

### T-016: 快捷键系统
- **状态**: ✅ DONE
- **描述**: 实现全局快捷键，快速唤起对话窗口。
- **涉及文件**:
  - 新建 `src/main/shortcuts.ts` — 全局快捷键注册（3 个默认快捷键 + 动态注册/注销）
  - `src/main/index.ts` — 集成快捷键初始化和清理
  - `src/main/ipc/index.ts` — 添加 `SYS_GET_SHORTCUTS`、`SYS_SET_SHORTCUTS` IPC handler
  - `src/preload/settings.ts` — 添加 `getShortcuts`、`setShortcuts` API
  - `src/renderer/settings/App.vue` — 快捷键配置 UI（录制式输入）
  - `src/shared/types.ts` — 添加快捷键 IPC 通道
- **完成内容**:
  - [x] `Ctrl+Shift+Z` 唤起/隐藏对话
  - [x] `Ctrl+Shift+N` 新建会话
  - [x] `Ctrl+Shift+P` 显示/隐藏宠物
  - [x] 快捷键可在设置中自定义（录制式输入，支持修饰键组合）
  - [x] 保存后自动重新注册全局快捷键
- **E2E 测试**: 4 个测试用例（默认配置读取、保存和读取、UI 显示、录制功能）

### T-017: Markdown 渲染优化
- **状态**: ✅ DONE
- **描述**: 优化 Markdown 渲染，支持代码高亮、表格、数学公式。
- **涉及文件**:
  - 新建 `src/renderer/chat/utils/markdown.ts` — Markdown 配置（markdown-it + highlight.js + 缓存）
  - `src/renderer/chat/components/ChatMessage.vue` — 使用新渲染器 + 完善样式
- **完成内容**:
  - [x] 代码块语法高亮（highlight.js，Catppuccin Mocha 配色）
  - [x] 表格渲染（带边框、条纹、滚动容器）
  - [x] 行内代码样式
  - [x] 链接可点击（target="_blank" + rel="noopener noreferrer"）
  - [x] 流式渲染时不闪烁（Map 缓存渲染结果，LRU 淘汰）
  - [x] 引用块和分隔线样式
  - [x] 有序/无序列表渲染
- **E2E 测试**: 6 个测试用例（代码高亮、行内代码、模块可用、流式缓存、表格、链接）

### T-018: 暗色主题
- **状态**: ✅ DONE
- **描述**: 支持暗色主题，跟随系统或手动切换。
- **涉及文件**:
  - 新建 `src/main/theme.ts` — 主题管理器（跟随系统 + 手动切换 + 通知所有窗口）
  - `src/main/index.ts` — 集成主题初始化
  - `src/main/ipc/index.ts` — 添加 `SYS_GET_THEME`、`SYS_SET_THEME`、`SYS_THEME_CHANGE` IPC handler
  - `src/preload/chat.ts`、`src/preload/settings.ts`、`src/preload/pet.ts` — 添加主题 API
  - `src/renderer/settings/App.vue` — 主题切换 UI（3 个选项：跟随系统/亮色/暗色）
  - `src/renderer/chat/App.vue` — 监听主题变化并应用 CSS 类
  - `src/renderer/pet/App.vue` — 监听主题变化
  - `src/renderer/pet/components/SpeechBubble.vue` — 气泡暗色适配
  - `src/renderer/chat/styles/chat.css` — 对话窗口暗色主题样式
  - `src/renderer/settings/styles/settings.css` — 设置面板暗色主题样式
  - `src/shared/types.ts` — 添加主题 IPC 通道
- **完成内容**:
  - [x] 跟随系统主题（nativeTheme + 系统主题变化监听）
  - [x] 手动切换亮/暗/系统
  - [x] 宠物猫头鹰暗色适配（气泡暗色背景）
  - [x] 所有组件统一主题（聊天/设置/宠物三窗口同步）
- **E2E 测试**: 7 个测试用例（默认读取、暗色切换、亮色切换、系统切换、UI 显示、设置面板切换、宠物窗口同步）

### T-019: 应用打包与分发
- **状态**: ✅ DONE
- **描述**: 使用 electron-builder 打包为安装包。
- **涉及文件**:
  - 新建 `electron-builder.yml` — 打包配置（Windows NSIS + macOS DMG + Linux AppImage）
  - `package.json` — 打包脚本 + electron-builder 依赖
  - 新建 `build/` — 图标资源目录
- **完成内容**:
  - [x] Windows NSIS 安装包（含桌面快捷方式、开始菜单快捷方式）
  - [x] macOS DMG（x64 + arm64）
  - [x] 应用图标配置（build/icon.ico）
  - [x] 自动更新配置（GitHub provider）
  - [x] 打包脚本：`npm run dist` / `npm run dist:win` / `npm run dist:mac` / `npm run dist:linux`
- **E2E 测试**: 6 个测试用例（配置文件存在、内容正确、打包脚本、依赖、build 引用、build 目录）

---

## P4 — 高级功能

### T-020: 语音输入
- **状态**: ✅ DONE
- **描述**: 支持语音输入，使用 Web Speech API 或 Whisper。
- **涉及文件**:
  - `src/renderer/chat/components/InputBar.vue` — 语音录制、波形动画、语言切换
- **完成内容**:
  - [x] 点击麦克风开始录音（Web Speech API SpeechRecognition）
  - [x] 实时转文字（interimResults + finalResults 双通道）
  - [x] 支持中英文（zh-CN / en-US 一键切换）
  - [x] 语音波形动画（24 条动态柱状图，80ms 刷新）
  - [x] 语音错误提示（不支持/权限拒绝/网络错误）
  - [x] 自动重启识别（continuous 模式意外停止时）
- **E2E 测试**: 5 个测试用例全部通过（麦克风按钮可见、切换录制状态、波形动画区域、语言切换按钮、文本输入不受影响）

### T-021: 多模态输入
- **状态**: ✅ DONE
- **描述**: 支持图片输入，Agent 可以分析图片内容。
- **涉及文件**:
  - `src/renderer/chat/components/InputBar.vue` — 图片拖拽/粘贴/选择/预览/压缩
  - `src/shared/types.ts` — ImageAttachment 类型定义
  - `src/main/ipc/index.ts` — 多模态消息处理（image_url 格式）
  - `src/preload/chat.ts` — send 方法支持 images 参数
- **完成内容**:
  - [x] 拖拽/粘贴图片（dragover/drop/paste 事件处理）
  - [x] 图片预览（缩略图列表，可移除）
  - [x] 发送给多模态 LLM（OpenAI image_url 格式，Base64 编码）
  - [x] 图片压缩优化（最大 2048px，JPEG 85% 质量，缩略图 200px）
  - [x] 10MB 文件大小限制
- **E2E 测试**: 6 个测试用例全部通过（图片按钮可见、拖拽覆盖层、无图片时预览区隐藏、发送按钮可用、按钮共存、消息渲染）

### T-022: 插件系统
- **状态**: ✅ DONE
- **描述**: 支持第三方插件扩展 Agent 能力。
- **涉及文件**:
  - 新建 `src/main/plugins/plugin-manager.ts` — 插件管理器（安装/卸载/启用/禁用/沙箱）
  - 新建 `src/main/windows/plugins-window.ts` — 插件管理窗口
  - 新建 `src/preload/plugins.ts` — 插件 preload API
  - 新建 `src/renderer/plugins/App.vue` — 插件管理 UI（列表/安装/搜索/统计）
  - 新建 `src/renderer/plugins/main.ts` — Vue 入口
  - 新建 `src/renderer/plugins/index.html` — 入口 HTML
  - 新建 `src/renderer/plugins/styles/plugins.css` — 样式
  - `src/shared/types.ts` — PluginManifest/PluginInfo/PluginPermission 类型
  - `src/main/ipc/index.ts` — 插件 IPC handler（5 个通道）
  - `src/main/tray.ts` — 插件管理菜单项
  - `electron.vite.config.ts` — plugins 入口配置
- **完成内容**:
  - [x] 插件加载机制（注册表 + 文件系统存储）
  - [x] 插件 API 设计（7 种权限：tool:register/memory:read/write/llm:call/ui:render/storage:read/write）
  - [x] 插件管理界面（列表/安装弹窗/搜索/统计栏/启用禁用/卸载）
  - [x] 插件沙箱隔离（new Function + 受限 global 对象）
- **E2E 测试**: 8 个测试用例全部通过（打开窗口、空列表、安装表单 UI、API 安装后 UI 显示、禁用插件、卸载插件、IPC 操作、统计栏）

### T-023: 数据导出/导入
- **状态**: ✅ DONE
- **描述**: 支持导出会话历史和记忆数据。
- **涉及文件**:
  - 新建 `src/main/storage/data-export.ts` — 导出/导入逻辑（JSON/Markdown 双格式）
  - `src/shared/types.ts` — ExportOptions/ExportResult/ImportResult 类型
  - `src/main/ipc/index.ts` — 数据导出/导入 IPC handler（3 个通道）
  - `src/preload/chat.ts` — chatAPI 暴露 exportData/importData/exportSessions
  - `src/preload/settings.ts` — settingsAPI 暴露 exportData/importData
  - `src/renderer/settings/App.vue` — 设置面板导出/导入 UI（格式选择/范围选择/按钮）
- **完成内容**:
  - [x] 导出为 JSON / Markdown（会话+消息+记忆，完整结构化数据）
  - [x] 导入历史数据（JSON 格式，会话+消息自动导入）
  - [x] 选择性导出（全部/仅会话/仅记忆，支持按会话 ID 和时间范围过滤）
  - [x] 导出文件保存对话框（dialog.showSaveDialog）
  - [x] 导入文件选择对话框（dialog.showOpenDialog）
- **E2E 测试**: 6 个测试用例全部通过（设置面板区域、格式选择器、范围选择器、导出导入按钮、chatAPI 方法、settingsAPI 方法）

### T-024: 离线模式
- **状态**: ✅ DONE
- **描述**: 支持本地 LLM 模型，完全离线运行。
- **涉及文件**:
  - 新建 `src/main/offline/ollama-manager.ts` — Ollama 管理器（状态检查/模型列表/下载/删除/配置）
  - `src/shared/types.ts` — OllamaModel/OllamaStatus/OllamaPullProgress 类型
  - `src/main/ipc/index.ts` — Ollama IPC handler（5 个通道）
  - `src/preload/settings.ts` — settingsAPI 暴露 Ollama 操作方法
  - `src/renderer/settings/App.vue` — 设置面板 Ollama UI（状态/切换/模型列表/下载/推荐）
- **完成内容**:
  - [x] 支持 Ollama 本地模型（/api/tags /api/pull /api/delete API 集成）
  - [x] 模型下载管理（流式进度通知、推荐模型列表 6 种）
  - [x] 离线模式启用/禁用（配置持久化到 offline-config.json）
  - [x] Ollama 在线状态检查（3 秒超时，自动检测服务可用性）
  - [x] 模型删除功能
  - [x] 推荐模型一键下载（llama3.2/qwen2.5/gemma2 等）
- **E2E 测试**: 8 个测试用例全部通过（Ollama 区域、状态显示、离线模式切换、刷新状态、模型下载 UI、推荐模型列表、IPC 状态查询、IPC 启用/禁用）

---

## 已完成任务

### T-000: 项目初始化与 E2E 测试框架
- **状态**: ✅ DONE
- **描述**: Electron + Vue 3 + Vite 项目搭建，双窗口架构，Playwright E2E 测试框架。
- **完成内容**:
  - 宠物窗口（猫头鹰 SVG + 8 种状态动画）
  - 对话窗口（消息列表 + 输入栏 + 流式输出）
  - IPC 通信层（chat/pet/system）
  - 系统托盘
  - Playwright E2E 测试（22 个测试用例）
  - TASKS.md 任务管理系统
