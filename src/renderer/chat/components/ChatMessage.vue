<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import type { ChatMessage, TraceStep, ImageAttachment } from '@shared/types'
import ExecutionTrace from './ExecutionTrace.vue'
import LiveTrace from './LiveTrace.vue'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{
  message: ChatMessage
  liveSteps?: TraceStep[]
}>()

const emit = defineEmits<{
  retry: []
}>()

// ── 复制消息 ──
const copied = ref(false)

async function copyMessage() {
  const text = props.message.content
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

const isUser = computed(() => props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')

// ── Markdown 渲染（使用 markdown-it + highlight.js）──
const renderedContent = computed(() => {
  if (isUser.value) return props.message.content
  return renderMarkdown(props.message.content)
})

const timeStr = computed(() => {
  const d = new Date(props.message.timestamp)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
})

/** 查看完整图片 */
function viewFullImage(img: ImageAttachment) {
  // 在新窗口中打开完整图片
  const w = window.open()
  if (w) {
    w.document.write(`<img src="data:${img.mimeType};base64,${img.data}" style="max-width:100%;max-height:100vh;object-fit:contain;" />`)
    w.document.title = `图片 ${img.width}x${img.height}`
  }
}

// ── 代码块交互（复制 + 预览） ──
const messageContentRef = ref<HTMLElement | null>(null)

/** 复制代码到剪贴板 */
async function copyCode(raw: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(raw)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = raw
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  // 临时改变按钮文字
  const span = btn.querySelector('span')
  if (span) {
    const original = span.textContent
    span.textContent = '已复制'
    btn.classList.add('copied')
    setTimeout(() => {
      span.textContent = original
      btn.classList.remove('copied')
    }, 1500)
  }
}

/** 预览 HTML/SVG 代码 */
function previewCode(raw: string, lang: string) {
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) return

  let content: string
  if (lang === 'svg' || lang === 'xml') {
    // SVG: 直接渲染
    content = raw
  } else {
    // HTML: 直接渲染
    content = raw
  }

  w.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>代码预览</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { padding: 20px; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .preview-container { background: #fff; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,0.1); padding: 30px; max-width: 100%; overflow: auto; }
  svg, img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div class="preview-container">${content}</div>
</body>
</html>`)
  w.document.close()
}

/** 处理代码块点击事件（事件委托） */
function handleCodeClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const btn = target.closest('.code-btn') as HTMLElement | null
  if (!btn) return

  e.preventDefault()
  e.stopPropagation()

  const rawEncoded = btn.dataset.raw
  if (!rawEncoded) return
  const raw = decodeURIComponent(rawEncoded)

  if (btn.classList.contains('code-copy-btn')) {
    copyCode(raw, btn)
  } else if (btn.classList.contains('code-preview-btn')) {
    const lang = btn.dataset.lang || 'html'
    previewCode(raw, lang)
  }
}

/** 绑定代码块点击事件 */
function bindCodeEvents() {
  if (messageContentRef.value) {
    messageContentRef.value.addEventListener('click', handleCodeClick)
  }
}

/** 解绑代码块点击事件 */
function unbindCodeEvents() {
  if (messageContentRef.value) {
    messageContentRef.value.removeEventListener('click', handleCodeClick)
  }
}

onMounted(() => {
  nextTick(() => bindCodeEvents())
})

onUnmounted(() => {
  unbindCodeEvents()
})

// 流式输出时重新绑定事件
watch(renderedContent, () => {
  nextTick(() => {
    unbindCodeEvents()
    bindCodeEvents()
  })
})
</script>

<template>
  <div class="chat-message" :class="{ 'msg-user': isUser, 'msg-assistant': isAssistant }" data-testid="chat-message">
    <!-- 头像 -->
    <div class="message-avatar">
      <svg v-if="isUser" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
      <svg v-else width="22" height="22" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
        <path d="M 58 62 Q 48 35 62 48 Q 58 42 58 62 Z" fill="#3A3A42"/>
        <path d="M 142 62 Q 152 35 138 48 Q 142 42 142 62 Z" fill="#3A3A42"/>
        <ellipse cx="100" cy="118" rx="58" ry="62" fill="#3A3A42"/>
        <ellipse cx="100" cy="128" rx="36" ry="42" fill="#E8E4DD"/>
        <circle cx="80" cy="92" r="23" fill="#E8E4DD"/>
        <circle cx="120" cy="92" r="23" fill="#E8E4DD"/>
        <circle cx="80" cy="92" r="13" fill="#F5A623"/>
        <circle cx="120" cy="92" r="13" fill="#F5A623"/>
        <circle cx="80" cy="92" r="8" fill="#1A1A1A"/>
        <circle cx="120" cy="92" r="8" fill="#1A1A1A"/>
        <circle cx="84" cy="88" r="4" fill="#FFFFFF"/>
        <circle cx="124" cy="88" r="4" fill="#FFFFFF"/>
        <path d="M 100 103 L 93 112 Q 100 117 107 112 Z" fill="#E8A030" stroke="#C88820" stroke-width="0.5"/>
      </svg>
    </div>

    <!-- 消息内容 -->
    <div class="message-body">
      <div class="message-header">
        <span class="message-sender">{{ isUser ? '你' : '小禅' }}</span>
        <span class="message-time">{{ timeStr }}</span>
      </div>

      <div class="message-content" ref="messageContentRef" v-html="renderedContent"></div>

      <!-- 图片附件展示 (T-021) -->
      <div v-if="message.images && message.images.length > 0" class="message-images" data-testid="message-images">
        <img
          v-for="img in message.images"
          :key="img.id"
          :src="`data:${img.mimeType};base64,${img.thumbnail || img.data}`"
          :alt="'图片附件'"
          class="message-image"
          data-testid="message-image"
          @click="() => viewFullImage(img)"
        />
      </div>

      <!-- 流式输出光标 -->
      <span v-if="message.streaming" class="streaming-cursor">▋</span>

      <!-- 实时追踪（流式输出中） -->
      <LiveTrace
        v-if="message.streaming && liveSteps && liveSteps.length > 0"
        :steps="liveSteps"
      />

      <!-- 执行追踪（完成后） -->
      <ExecutionTrace v-if="message.trace" :trace="message.trace" />

      <!-- 消息底部操作栏 -->
      <div v-if="!message.streaming && message.content" class="message-actions">
        <button
          class="msg-action-btn"
          :class="{ copied }"
          :title="copied ? '已复制' : '复制'"
          @click.stop="copyMessage"
        >
          <svg v-if="copied" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <button
          v-if="isAssistant"
          class="msg-action-btn"
          title="重新生成"
          @click.stop="emit('retry')"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          <span>重试</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-message {
  display: flex;
  gap: 12px;
  padding: 14px 18px;
  transition: opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}

.msg-user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
  background: var(--surface-tint);
  transition: background 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}

.msg-user .message-avatar {
  background: var(--color-brand-soft);
}

.msg-assistant .message-avatar {
  background: var(--color-amber-soft);
}

.message-body {
  max-width: 80%;
  display: flex;
  flex-direction: column;
}

.msg-user .message-body {
  align-items: flex-end;
}

.message-header {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 6px;
}

.message-sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.message-time {
  font-size: 11px;
  color: var(--text-meta);
  font-weight: 400;
}

.message-content {
  font-size: 14px;
  line-height: 1.65;
  color: var(--text-primary);
  word-break: break-word;
}

.msg-user .message-content {
  padding: 10px 14px;
  background: var(--color-brand-soft);
  border-radius: 14px 14px 4px 14px;
  color: var(--text-primary);
  border: 1px solid var(--color-brand-border);
}

.msg-assistant .message-content {
  padding: 0;
}

/* ── 消息底部操作栏 ── */
.message-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.chat-message:hover .message-actions {
  opacity: 1;
}

.msg-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--text-meta);
  font-size: 11px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.msg-action-btn:hover {
  background: var(--surface-tint-hover);
  color: var(--text-primary);
}

.msg-action-btn.copied {
  color: var(--color-brand);
}

/* Markdown 样式 */
.message-content :deep(.code-block-wrapper) {
  margin: 8px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #313244;
}

.message-content :deep(.code-toolbar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #181825;
  border-bottom: 1px solid #313244;
}

.message-content :deep(.code-lang) {
  font-size: 11px;
  font-weight: 600;
  color: #6c7086;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.message-content :deep(.code-actions) {
  display: flex;
  gap: 4px;
}

.message-content :deep(.code-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid #313244;
  border-radius: 4px;
  background: transparent;
  color: #6c7086;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.message-content :deep(.code-btn:hover) {
  background: #313244;
  color: #cdd6f4;
  border-color: #45475a;
}

.message-content :deep(.code-btn.copied) {
  color: #a6e3a1 !important;
  border-color: #a6e3a1 !important;
}

.message-content :deep(.code-btn span) {
  line-height: 1;
}

.message-content :deep(.code-block) {
  margin: 0;
  padding: 12px 14px;
  background: #1e1e2e;
  overflow-x: auto;
}

.message-content :deep(.code-block code) {
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  color: #cdd6f4;
  white-space: pre;
  line-height: 1.5;
}

/* highlight.js 主题适配 */
.message-content :deep(.hljs-keyword),
.message-content :deep(.hljs-selector-tag),
.message-content :deep(.hljs-built_in),
.message-content :deep(.hljs-name),
.message-content :deep(.hljs-tag) {
  color: #cba6f7;
}

.message-content :deep(.hljs-string),
.message-content :deep(.hljs-title),
.message-content :deep(.hljs-section),
.message-content :deep(.hljs-attribute),
.message-content :deep(.hljs-literal),
.message-content :deep(.hljs-template-tag),
.message-content :deep(.hljs-template-variable),
.message-content :deep(.hljs-type),
.message-content :deep(.hljs-addition) {
  color: #a6e3a1;
}

.message-content :deep(.hljs-comment),
.message-content :deep(.hljs-quote),
.message-content :deep(.hljs-deletion),
.message-content :deep(.hljs-meta) {
  color: #6c7086;
}

.message-content :deep(.hljs-number),
.message-content :deep(.hljs-symbol),
.message-content :deep(.hljs-bullet),
.message-content :deep(.hljs-attr),
.message-content :deep(.hljs-variable),
.message-content :deep(.hljs-template-variable),
.message-content :deep(.hljs-class .hljs-title),
.message-content :deep(.hljs-function .hljs-title) {
  color: #fab387;
}

.message-content :deep(.hljs-params) {
  color: #f9e2af;
}

.message-content :deep(.inline-code) {
  padding: 1px 6px;
  background: var(--surface-tint);
  border-radius: 4px;
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 13px;
  color: var(--color-red);
}

.message-content :deep(strong) {
  font-weight: 700;
  color: var(--text-primary);
}

.message-content :deep(h2),
.message-content :deep(h3),
.message-content :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 700;
  color: var(--text-primary);
}

.message-content :deep(h2) { font-size: 17px; }
.message-content :deep(h3) { font-size: 16px; }
.message-content :deep(h4) { font-size: 14px; }

.message-content :deep(ul),
.message-content :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}

.message-content :deep(li) {
  margin: 3px 0;
}

/* 表格样式 */
.message-content :deep(.table-wrapper) {
  margin: 10px 0;
  overflow-x: auto;
}

.message-content :deep(.md-table) {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}

.message-content :deep(.md-table th),
.message-content :deep(.md-table td) {
  border: 1px solid var(--surface-border);
  padding: 8px 12px;
  text-align: left;
}

.message-content :deep(.md-table th) {
  background: var(--surface-tint);
  font-weight: 600;
  color: var(--text-primary);
}

.message-content :deep(.md-table tr:nth-child(even) td) {
  background: var(--surface-tint);
}

/* 链接样式 */
.message-content :deep(a) {
  color: var(--color-brand);
  text-decoration: none;
  border-bottom: 1px dashed var(--color-brand-border);
  transition: color 0.15s, border-color 0.15s;
}

.message-content :deep(a:hover) {
  color: var(--color-brand-hover);
  border-bottom-style: solid;
  border-bottom-color: var(--color-brand);
}

/* 引用块样式 */
.message-content :deep(blockquote) {
  margin: 10px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--color-brand);
  background: var(--color-brand-softer);
  color: var(--text-secondary);
  border-radius: 0 6px 6px 0;
}

/* 分隔线样式 */
.message-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--surface-border);
  margin: 12px 0;
}

.streaming-cursor {
  display: inline-block;
  color: var(--color-brand);
  animation: blink 0.8s steps(2) infinite;
}

@keyframes blink {
  to { opacity: 0; }
}

/* ═══ 图片附件 ═══ */
.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  max-width: 320px;
}

.message-image {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: 10px;
  cursor: pointer;
  border: 1px solid var(--surface-border);
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1),
    box-shadow 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}

.message-image:hover {
  transform: scale(1.03);
  box-shadow: 0 6px 16px rgba(91, 170, 138, 0.12);
}
</style>
