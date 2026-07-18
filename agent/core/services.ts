/**
 * AgentServices — Agent 核心依赖的注入容器
 *
 * 背景:
 * agent 层历史上通过模块级单例（memoryManager、skillStore、patternDetector、llm）
 * 隐式共享依赖，导致:
 * 1. 无法写单元测试（无法注入 mock）
 * 2. 会话间状态串扰
 * 3. 依赖关系不可见（import 顺序即依赖图）
 *
 * 设计:
 * - AgentLoop / Pipeline 各阶段通过构造函数或上下文接收 AgentServices
 * - 生产环境使用 getDefaultServices()（沿用现有单例，行为不变）
 * - 测试环境可构造纯内存的 fake services 注入
 */

import { LLMProvider, llm } from '../providers/llm'
import { MemoryManager, memoryManager } from '../memory/memory-manager'
import { SkillStore, skillStore } from '../evolution/interaction/skill-store'
import { PatternDetector, patternDetector } from '../evolution/interaction/pattern-detector'

/** Agent 核心运行所需的全部外部依赖 */
export interface AgentServices {
  /** LLM 调用 */
  llm: LLMProvider
  /** 记忆管理（检索 / 存储） */
  memory: MemoryManager
  /** 技能库（匹配 / 生成） */
  skills: SkillStore
  /** 模式检测（进化信号） */
  patterns: PatternDetector
}

/**
 * 基于现有模块级单例构建默认服务集。
 * 保持与历史行为完全一致 —— 各模块的单例仍是同一份状态。
 */
export function createDefaultServices(): AgentServices {
  return {
    llm,
    memory: memoryManager,
    skills: skillStore,
    patterns: patternDetector
  }
}

let sharedDefaults: AgentServices | null = null

/** 获取进程内共享的默认服务集（惰性创建） */
export function getDefaultServices(): AgentServices {
  if (!sharedDefaults) {
    sharedDefaults = createDefaultServices()
  }
  return sharedDefaults
}

/** 测试专用：允许用部分 mock 覆盖默认值 */
export function createTestServices(overrides: Partial<AgentServices> = {}): AgentServices {
  return {
    ...createDefaultServices(),
    ...overrides
  }
}
