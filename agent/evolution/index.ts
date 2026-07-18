/**
 * Evolution — Agent 自我进化能力
 *
 * 本包下分两个职责正交的子域，命名即边界:
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ interaction/   运行时交互级进化（不碰源码）                          │
 * │   每轮对话触发:                                                      │
 * │   - pattern-detector   检测重复请求模式                              │
 * │   - skill-generator    生成可复用技能（Prompt 模板 + 工具链）         │
 * │   - skill-store        技能存储 / 向量匹配 / 上下文注入               │
 * │   - prompt-optimizer   基于用户负反馈优化系统 Prompt **文本**         │
 * │   - feedback-collector 显式/隐式反馈收集                             │
 * │   产物: 新的 Prompt 版本、新技能 —— 都是数据，不是代码变更           │
 * └──────────────────────────────────────────────────────────────────────┘
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ code/          代码级自进化（修改自身源码）                          │
 * │   空闲时触发，有完整安全兜底:                                         │
 * │   - orchestrator       编排: 分析→计划→改码→编译测试→评估→提交/回滚  │
 * │   - log-analyzer       分析执行追踪/反思/反馈，发现改进点             │
 * │   - code-modifier      生成并应用源码补丁（白名单目录）              │
 * │   - build-tester       编译 + 测试验证                               │
 * │   - evolution-journal  进化记录持久化                                │
 * │   - token-budget       进化 Token 预算管理                           │
 * │   产物: .ts 源码改动 + git commit；失败自动 git revert/stash 回滚    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 二者关系:
 * - interaction/ 是"软进化"，改的是运行时数据（Prompt/技能），低风险、高频。
 * - code/ 是"硬进化"，改的是程序自身源码，高风险、低频，有 git 回滚保护。
 * - code/log-analyzer 会读取 interaction/prompt-optimizer 等作为改进目标文件，
 *   这是单向依赖：code/ 观察 interaction/ 的产物并决定是否改其源码，反之不成立。
 *
 * 历史命名: interaction/ 原位于 agent/evolution/，code/ 原位于 agent/self-evolution/。
 * 2026 年重组为统一 evolution 包下的两个子域，消除命名歧义。
 */

// 本文件仅作边界文档，不 re-export；各子域请直接按路径引用，例如：
//   from '@agent/evolution/interaction/prompt-optimizer'
//   from '@agent/evolution/code/orchestrator'
export const EVOLUTION_PACKAGE_DOC = true
