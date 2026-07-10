/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// ── Window API 类型声明（由 preload 注入）──

interface PetAPI {
  onClick: () => void
  onDrag: (deltaX: number, deltaY: number) => void
  onRightClick: () => void
  onBubbleAction: (actionId: string) => Promise<unknown>
  onStateChange: (callback: (data: import('./src/shared/types').PetStateData) => void) => () => void
  onShowBubble: (callback: (bubble: import('./src/shared/types').PetStateData['bubble']) => void) => () => void
}

interface ChatAPI {
  send: (message: string) => Promise<unknown>
  stop: () => Promise<unknown>
  newSession: () => Promise<{ sessionId: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>
  loadHistory: (sessionId: string) => Promise<{ messages: import('./src/shared/types').ChatMessage[]; sessionId: string }>
  approvePlan: (planId: string, approved: boolean) => Promise<unknown>
  approveTool: (toolCallId: string, approved: boolean) => Promise<unknown>
  onResponseChunk: (callback: (data: { delta: string; messageId: string }) => void) => () => void
  onResponseDone: (callback: (data: { messageId: string }) => void) => () => void
  onResponseError: (callback: (error: { message: string }) => void) => () => void
  onTraceStep: (callback: (step: import('./src/shared/types').TraceStep) => void) => () => void
  onTraceComplete: (callback: (trace: import('./src/shared/types').ExecutionTrace) => void) => () => void
  close: () => Promise<unknown>
}

interface Window {
  petAPI: PetAPI
  chatAPI: ChatAPI
}
