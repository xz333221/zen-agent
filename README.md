# Zen Agent 🦉

自我进化的 AI Agent 桌面应用 — 智慧小猫头鹰「小禅」

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（启动 Electron + Vite HMR）
npm run dev

# 构建生产版本
npm run build

# 预览生产版本
npm run preview
```

## 架构概览

```
zen-agent/
├── electron/           # Electron 主进程（窗口管理、IPC、托盘）
│   ├── main/           # 主进程入口
│   │   ├── index.ts    # 应用生命周期
│   │   ├── windows/    # 宠物窗口 + 对话窗口
│   │   ├── ipc/        # IPC 处理器
│   │   └── tray.ts     # 系统托盘
│   └── preload/        # 安全 IPC 桥
│       ├── pet.ts      # 宠物窗口 preload
│       └── chat.ts     # 对话窗口 preload
│
├── src/renderer/       # Vue 3 渲染进程
│   ├── pet/            # 🦉 桌面宠物（透明置顶窗口）
│   │   ├── components/
│   │   │   ├── ZenOwl.vue       # SVG 猫头鹰 + CSS 动画
│   │   │   └── SpeechBubble.vue  # 气泡通知
│   │   └── App.vue
│   │
│   └── chat/           # 💬 对话窗口
│       ├── components/
│       │   ├── ChatMessage.vue     # 消息渲染（Markdown）
│       │   ├── ExecutionTrace.vue  # 可折叠执行追踪
│       │   └── InputBar.vue        # 输入栏
│       ├── stores/chat.ts          # Pinia 状态管理
│       └── App.vue
│
├── agent/              # 🧠 Agent 核心引擎（主进程）
│   ├── core/
│   │   ├── agent-loop.ts  # ReAct 循环
│   │   └── types.ts       # 核心类型
│   ├── providers/
│   │   ├── llm.ts         # 多模型 LLM 抽象层
│   │   └── types.ts
│   ├── memory/            # 记忆系统类型
│   ├── skills/            # 技能系统类型
│   ├── tools/             # 工具系统类型
│   └── evolution/         # 进化系统类型
│
├── src/shared/         # 主进程/渲染进程共享类型
│   └── types.ts
│
└── data/               # 本地数据（SQLite、向量、技能、日志）
```

## 核心特性

### 🦉 桌面宠物
- SVG 猫头鹰角色，8 种状态动画（idle/listening/thinking/working/happy/confused/sleeping/evolving）
- 透明置顶窗口，可拖拽
- 气泡通知系统

### 💬 对话窗口
- 流式输出
- Markdown 渲染 + 代码高亮
- 可折叠执行追踪（4 层折叠：摘要 → 步骤 → 详情 → 原始数据）

### 🧠 Agent 引擎
- ReAct (Reason → Act → Observe) 循环
- 多模型路由（强模型规划，快速模型执行）
- 上下文预算管理（Token 分配 + 滑动窗口 + 渐进压缩）
- 多 Agent 协作（Coordinator + 子 Agent）

### 🔄 自我进化
- 记忆系统（情景 + 语义 + 程序记忆）
- 技能自动生成（模式检测 → 草稿 → 用户确认 → 迭代）
- Prompt 自优化（A/B 测试 + 版本管理）
- 知识图谱构建

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 33 + Vue 3.5 |
| 构建 | electron-vite + Vite 5 |
| 语言 | TypeScript 5.7 |
| 状态管理 | Pinia |
| LLM 调用 | OpenAI SDK（兼容多家） |
| 数据存储 | sql.js (SQLite WASM) |
| 向量检索 | LanceDB（待集成） |

## 开发路线

- [x] Phase 1: 项目骨架 + 宠物窗口 + 对话窗口
- [ ] Phase 2: Agent 内核（ReAct 循环 + 工具系统 + 记忆检索）
- [ ] Phase 3: 进化机制（技能生成 + Prompt 优化 + 模式检测）
- [ ] Phase 4: 多 Agent 协作 + 体验打磨
