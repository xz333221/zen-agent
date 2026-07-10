<script setup lang="ts">
import { ref, nextTick, onUnmounted, computed } from 'vue'
import type { ImageAttachment } from '@shared/types'

const props = defineProps<{
  disabled?: boolean
  streaming?: boolean
}>()

const emit = defineEmits<{
  send: [message: string, images?: ImageAttachment[]]
  stop: []
}>()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// ── 语音输入状态 (T-020) ──
// 使用 MediaRecorder + IPC Whisper API 替代不可用的 Web Speech API
const isRecording = ref(false)
const isTranscribing = ref(false)
const voiceLang = ref<'zh-CN' | 'en-US'>('zh-CN')
const voiceError = ref('')
const waveformBars = ref<number[]>(new Array(24).fill(3))

// MediaRecorder 相关引用
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let audioStream: MediaStream | null = null
let waveformInterval: ReturnType<typeof setInterval> | null = null

/** 检查是否支持语音录制 */
function isVoiceSupported(): boolean {
  return typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof MediaRecorder !== 'undefined'
}

/** 开始/停止录音 */
async function startRecording() {
  // 如果正在转写中，忽略
  if (isTranscribing.value) return

  // 如果正在录音，停止并转写
  if (isRecording.value) {
    await stopAndTranscribe()
    return
  }

  if (!isVoiceSupported()) {
    voiceError.value = '当前环境不支持语音录制，请直接输入文字'
    setTimeout(() => { voiceError.value = '' }, 5000)
    return
  }

  try {
    // 请求麦克风权限
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []

    // 创建 MediaRecorder
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'

    mediaRecorder = new MediaRecorder(audioStream, { mimeType })

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data)
      }
    }

    mediaRecorder.start()
    isRecording.value = true
    startWaveformAnimation()
  } catch (err) {
    const error = err as Error
    if (error.name === 'NotAllowedError') {
      voiceError.value = '请允许麦克风访问权限'
    } else if (error.name === 'NotFoundError') {
      voiceError.value = '未检测到麦克风设备'
    } else {
      voiceError.value = `启动录音失败: ${error.message || '未知错误'}`
    }
    setTimeout(() => { voiceError.value = '' }, 5000)
    cleanupRecording()
  }
}

/** 停止录音并进行语音转文字 */
async function stopAndTranscribe() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    stopRecording()
    return
  }

  // 停止录音并等待最后的数据
  const mimeType = mediaRecorder.mimeType || 'audio/webm'
  const stopped = new Promise<void>((resolve) => {
    mediaRecorder!.onstop = () => resolve()
  })
  mediaRecorder.stop()
  await stopped

  // 清理录音状态
  isRecording.value = false
  stopWaveformAnimation()
  cleanupRecording()

  // 如果没有录到音频数据，直接返回
  if (audioChunks.length === 0) {
    voiceError.value = '未录到音频，请重试'
    setTimeout(() => { voiceError.value = '' }, 3000)
    return
  }

  // 合并音频块并转为 base64
  const audioBlob = new Blob(audioChunks, { type: mimeType })
  const audioBase64 = await blobToBase64(audioBlob)

  // 调用主进程进行语音转文字
  isTranscribing.value = true
  try {
    const langCode = voiceLang.value === 'zh-CN' ? 'zh' : 'en'
    const result = await window.chatAPI.transcribe(audioBase64, mimeType, langCode)

    if (result.success && result.text) {
      // 将转写文字追加到输入框
      const existing = inputText.value.trim()
      inputText.value = existing
        ? `${existing} ${result.text}`
        : result.text
      autoResize()
    } else {
      voiceError.value = result.error || '语音识别失败，请直接输入文字'
      setTimeout(() => { voiceError.value = '' }, 5000)
    }
  } catch (err) {
    const error = err as Error
    voiceError.value = error.message || '语音识别请求失败，请直接输入文字'
    setTimeout(() => { voiceError.value = '' }, 5000)
  } finally {
    isTranscribing.value = false
    audioChunks = []
  }
}

/** 停止录音（不转写） */
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop() } catch {}
  }
  isRecording.value = false
  stopWaveformAnimation()
  cleanupRecording()
}

/** 清理录音资源 */
function cleanupRecording() {
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop())
    audioStream = null
  }
  mediaRecorder = null
}

/** Blob 转 base64 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // 去掉 data:audio/webm;base64, 前缀
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** 切换语音语言 */
function toggleVoiceLang() {
  voiceLang.value = voiceLang.value === 'zh-CN' ? 'en-US' : 'zh-CN'
}

/** 波形动画 */
function startWaveformAnimation() {
  waveformInterval = setInterval(() => {
    waveformBars.value = waveformBars.value.map(() => {
      return Math.random() * 17 + 3
    })
  }, 80)
}

/** 停止波形动画 */
function stopWaveformAnimation() {
  if (waveformInterval) {
    clearInterval(waveformInterval)
    waveformInterval = null
  }
  waveformBars.value = new Array(24).fill(3)
}

onUnmounted(() => {
  if (isRecording.value) {
    stopRecording()
  }
  cleanupRecording()
})

// ── 图片附件 (T-021) ──
const pendingImages = ref<ImageAttachment[]>([])
const isDragOver = ref(false)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_DIMENSION = 2048
const COMPRESSION_QUALITY = 0.85

/** 是否可以发送 */
const canSend = computed(() => {
  return !props.disabled && (inputText.value.trim() || pendingImages.value.length > 0)
})

/** 处理图片文件 */
async function processImageFile(file: File): Promise<ImageAttachment | null> {
  if (!file.type.startsWith('image/')) {
    return null
  }

  // 读取图片
  const img = await loadImage(file)
  if (!img) return null

  // 压缩图片
  const { dataUrl, width, height, size } = await compressImage(img, file.type)

  // 生成缩略图
  const thumbnail = await generateThumbnail(img, 200)

  // 提取 base64 数据
  const base64Data = dataUrl.split(',')[1]

  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data: base64Data,
    mimeType: file.type,
    width,
    height,
    size,
    thumbnail
  }
}

/** 加载图片 */
function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = e.target?.result as string
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** 压缩图片 */
async function compressImage(
  img: HTMLImageElement,
  mimeType: string
): Promise<{ dataUrl: string; width: number; height: number; size: number }> {
  let { naturalWidth: width, naturalHeight: height } = img

  // 按最大尺寸缩放
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height)
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, width, height)

  // 统一转为 JPEG 压缩（如果是 PNG 也压缩）
  const outputType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
  const dataUrl = canvas.toDataURL(outputType, COMPRESSION_QUALITY)

  // 估算大小
  const size = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)

  return { dataUrl, width, height, size }
}

/** 生成缩略图 */
async function generateThumbnail(img: HTMLImageElement, maxSize: number): Promise<string> {
  const canvas = document.createElement('canvas')
  const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1)
  canvas.width = Math.round(img.naturalWidth * ratio)
  canvas.height = Math.round(img.naturalHeight * ratio)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.6)
}

/** 添加图片 */
async function addImages(files: FileList | File[]) {
  const fileArray = Array.from(files).filter(f => f.type.startsWith('image/'))
  for (const file of fileArray) {
    if (file.size > MAX_IMAGE_SIZE) {
      voiceError.value = `图片 ${file.name} 超过 10MB 限制`
      setTimeout(() => { voiceError.value = '' }, 3000)
      continue
    }
    const attachment = await processImageFile(file)
    if (attachment) {
      pendingImages.value.push(attachment)
    }
  }
}

/** 移除图片 */
function removeImage(id: string) {
  pendingImages.value = pendingImages.value.filter(img => img.id !== id)
}

/** 拖拽事件处理 */
function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  if (e.dataTransfer?.files) {
    addImages(e.dataTransfer.files)
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
}

/** 粘贴事件处理 */
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const imageFiles: File[] = []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) imageFiles.push(file)
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault()
    addImages(imageFiles)
  }
}

/** 选择图片文件 */
function selectImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => {
    if (input.files) {
      addImages(input.files)
    }
  }
  input.click()
}

async function autoResize() {
  await nextTick()
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

function handleSend() {
  const text = inputText.value.trim()
  if ((!text && pendingImages.value.length === 0) || props.disabled) return
  const images = pendingImages.value.length > 0 ? [...pendingImages.value] : undefined
  emit('send', text, images)
  inputText.value = ''
  pendingImages.value = []
  autoResize()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="input-bar" data-testid="input-bar">
    <!-- 语音错误提示 -->
    <div v-if="voiceError" class="voice-error" data-testid="voice-error">
      {{ voiceError }}
    </div>

    <!-- 语音波形动画 -->
    <div v-if="isRecording" class="voice-waveform" data-testid="voice-waveform">
      <div class="waveform-bars">
        <div
          v-for="(h, i) in waveformBars"
          :key="i"
          class="waveform-bar"
          :style="{ height: h + 'px' }"
        ></div>
      </div>
      <span class="waveform-label">正在录音... {{ voiceLang === 'zh-CN' ? '中文' : 'English' }}</span>
    </div>

    <!-- 语音转写中状态 -->
    <div v-if="isTranscribing" class="voice-waveform transcribing" data-testid="voice-transcribing">
      <div class="transcribing-spinner"></div>
      <span class="waveform-label">正在识别语音...</span>
    </div>

    <!-- 图片预览区 (T-021) -->
    <div v-if="pendingImages.length > 0" class="image-preview-bar" data-testid="image-preview-bar">
      <div v-for="img in pendingImages" :key="img.id" class="image-preview-item">
        <img :src="`data:${img.mimeType};base64,${img.thumbnail || img.data}`" :alt="'图片'" class="preview-thumb" />
        <button class="image-remove-btn" data-testid="btn-remove-image" @click="removeImage(img.id)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
    </div>

    <!-- 输入卡片 -->
    <div class="input-card" :class="{ 'is-recording': isRecording, 'is-streaming': streaming }">
      <!-- 文本输入区 -->
      <div class="textarea-wrapper" @drop="onDrop" @dragover="onDragOver" @dragleave="onDragLeave">
        <textarea
          ref="textareaRef"
          v-model="inputText"
          class="input-textarea"
          :class="{ 'drag-over': isDragOver }"
          data-testid="input-textarea"
          :placeholder="isRecording ? '语音输入中...再次点击麦克风结束' : isTranscribing ? '正在识别语音...' : '输入消息... (Enter 发送, Shift+Enter 换行, 可拖拽/粘贴图片)'"
          rows="1"
          :disabled="disabled && !streaming"
          @input="autoResize"
          @keydown="handleKeydown"
          @paste="onPaste"
        ></textarea>
        <div v-if="isDragOver" class="drop-overlay" data-testid="drop-overlay">
          松开以添加图片
        </div>
      </div>

      <!-- 工具栏 -->
      <div class="input-toolbar">
        <div class="toolbar-left">
          <!-- 麦克风 -->
          <button
            class="toolbar-btn"
            :class="{ recording: isRecording, transcribing: isTranscribing }"
            data-testid="btn-mic"
            :title="isRecording ? '停止录音并识别' : isTranscribing ? '识别中...' : '语音输入'"
            :disabled="isTranscribing"
            @click="startRecording"
          >
            <svg v-if="!isRecording && !isTranscribing" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            <svg v-else-if="isRecording" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          </button>

          <!-- 图片 -->
          <button
            v-if="!streaming"
            class="toolbar-btn"
            data-testid="btn-image"
            title="添加图片"
            @click="selectImage"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
          </button>

          <!-- 语言切换 -->
          <button
            v-if="isRecording"
            class="toolbar-btn lang-btn"
            data-testid="btn-voice-lang"
            :title="voiceLang === 'zh-CN' ? '当前中文，点击切换英文' : '当前英文，点击切换中文'"
            @click="toggleVoiceLang"
          >
            {{ voiceLang === 'zh-CN' ? '中' : 'EN' }}
          </button>
        </div>

        <div class="toolbar-right">
          <!-- 发送 / 停止 -->
          <button
            v-if="!streaming"
            class="toolbar-btn send-btn"
            data-testid="btn-send"
            :disabled="!canSend"
            title="发送"
            @click="handleSend"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
          <button
            v-else
            class="toolbar-btn stop-btn"
            data-testid="btn-stop"
            title="停止生成"
            @click="emit('stop')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.input-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 14px;
  background: var(--surface-card-soft);
  backdrop-filter: blur(20px) saturate(180%);
  border-top: 1px solid var(--surface-divider);
  flex-shrink: 0;
}

/* ═══ 输入卡片 ═══ */
.input-card {
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-card);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  overflow: hidden;
}

.input-card:focus-within {
  border-color: var(--color-brand);
  box-shadow: 0 0 0 3px var(--color-brand-softer);
}

.input-card.is-recording {
  border-color: var(--color-red);
  box-shadow: 0 0 0 3px var(--color-red-soft);
}

/* ═══ 文本输入区 ═══ */
.textarea-wrapper {
  position: relative;
}

.input-textarea {
  display: block;
  width: 100%;
  padding: 12px 16px;
  border: none;
  background: transparent;
  font-size: 15px;
  font-family: inherit;
  color: var(--text-primary);
  line-height: 1.55;
  resize: none;
  outline: none;
  min-height: 24px;
  max-height: 200px;
  overflow-y: auto;
}

.input-textarea::placeholder {
  color: var(--text-meta);
}

.input-textarea:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.input-textarea.drag-over {
  background: var(--color-brand-softer);
}

.drop-overlay {
  position: absolute;
  inset: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-brand-softer);
  border: 2px dashed var(--color-brand);
  border-radius: var(--radius-input);
  font-size: 14px;
  font-weight: 500;
  color: var(--color-brand);
  pointer-events: none;
}

/* ═══ 工具栏 ═══ */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--surface-divider);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-button);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
  flex-shrink: 0;
  background: transparent;
  color: var(--text-meta);
}

.toolbar-btn:hover:not(:disabled) {
  background: var(--surface-tint-hover);
  color: var(--text-primary);
}

.toolbar-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.toolbar-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* ═══ 发送按钮 ═══ */
.send-btn {
  background: var(--color-brand);
  color: var(--text-on-brand);
  box-shadow: 0 2px 8px rgba(91, 170, 138, 0.25);
}

.send-btn:hover:not(:disabled) {
  background: var(--color-brand-hover);
  color: var(--text-on-brand);
  box-shadow: 0 4px 12px rgba(91, 170, 138, 0.35);
}

.send-btn:disabled {
  background: var(--surface-tint);
  color: var(--text-meta);
  box-shadow: none;
}

/* ═══ 停止按钮 ═══ */
.stop-btn {
  background: var(--color-red);
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(232, 93, 93, 0.25);
}

.stop-btn:hover {
  background: var(--color-red);
  color: #ffffff;
  filter: brightness(1.08);
}

/* ═══ 麦克风按钮（录音中）═══ */
.toolbar-btn.recording {
  background: var(--color-red);
  color: #ffffff;
  animation: mic-pulse 1.5s ease-in-out infinite;
}

.toolbar-btn.transcribing {
  background: var(--color-brand);
  color: var(--text-on-brand);
  opacity: 0.8;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(232, 93, 93, 0.45); }
  50% { box-shadow: 0 0 0 6px rgba(232, 93, 93, 0); }
}

/* ═══ 语言切换按钮 ═══ */
.lang-btn {
  font-size: 12px;
  font-weight: 600;
  width: 36px;
}

/* ═══ 语音波形 ═══ */
.voice-waveform {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--color-red-soft);
  border-radius: var(--radius-input);
}

.waveform-bars {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
}

.waveform-bar {
  width: 3px;
  min-height: 3px;
  background: var(--color-red);
  border-radius: 2px;
  transition: height 0.08s ease;
}

.waveform-label {
  font-size: 13px;
  color: var(--color-red);
  font-weight: 500;
}

/* ═══ 语音转写中 ═══ */
.voice-waveform.transcribing {
  background: var(--color-brand-softer);
}

.voice-waveform.transcribing .waveform-label {
  color: var(--color-brand);
}

.transcribing-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--color-brand);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* ═══ 语音错误提示 ═══ */
.voice-error {
  padding: 8px 12px;
  background: var(--color-red-soft);
  border-radius: var(--radius-input);
  font-size: 13px;
  color: var(--color-red);
  line-height: 1.5;
}

/* ═══ 图片预览 ═══ */
.image-preview-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.image-preview-item {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--surface-border);
}

.preview-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-remove-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background 0.15s;
}

.image-remove-btn:hover {
  background: rgba(0, 0, 0, 0.9);
}
</style>
