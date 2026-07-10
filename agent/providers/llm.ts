/**
 * LLM Provider — 多模型抽象层
 *
 * 基于 OpenAI SDK，兼容所有 OpenAI-compatible API。
 * 支持多 provider 切换、流式输出、超时控制、<think> 标签过滤。
 *
 * 设计参考: article-generator/server/src/services/llm.ts
 */

import OpenAI, { toFile } from 'openai'
import type { LLMConfig, ProviderEntry, ModelKey, ChatRequest, ChatStreamCallbacks } from './types'

// ── 默认超时: 8 分钟 ──
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

// ── <think> 标签过滤 ──
const THINK_OPEN = '<' + 'think' + '>'
const THINK_CLOSE = '<' + '/' + 'think' + '>'
const THINK_TAG_RE = new RegExp(`${THINK_OPEN}[\\s\\S]*?${THINK_CLOSE}`, 'gi')

/**
 * 流式 <think> 标签过滤器
 * 处理跨 chunk 边界的标签碎片
 */
class ThinkFilter {
  private buf = ''
  private inside = false

  feed(delta: string): string {
    let out = ''
    let cursor = this.buf + delta
    this.buf = ''

    while (cursor.length > 0) {
      if (this.inside) {
        const end = cursor.indexOf(THINK_CLOSE)
        if (end !== -1) {
          this.inside = false
          cursor = cursor.slice(end + THINK_CLOSE.length)
        } else {
          this.buf = cursor.slice(-Math.max(0, THINK_CLOSE.length - 1))
          break
        }
      } else {
        const start = cursor.indexOf(THINK_OPEN)
        if (start !== -1) {
          out += cursor.slice(0, start)
          this.inside = true
          cursor = cursor.slice(start + THINK_OPEN.length)
        } else {
          out += cursor.slice(0, -Math.max(0, THINK_OPEN.length - 1))
          this.buf = cursor.slice(-Math.max(0, THINK_OPEN.length - 1))
          break
        }
      }
    }
    return out
  }

  flush(): string {
    const out = this.inside ? '' : this.buf
    this.buf = ''
    this.inside = false
    return out
  }
}

export class LLMProvider {
  private providers = new Map<string, ProviderEntry>()
  private clientCache = new Map<string, OpenAI>()
  private defaultModelKey: ModelKey = ''

  /** 注册 provider */
  registerProvider(entry: ProviderEntry): void {
    this.providers.set(entry.id, entry)
    // 清除对应的客户端缓存
    const cacheKey = `${entry.baseURL}::${entry.apiKey}`
    this.clientCache.delete(cacheKey)
  }

  /** 设置默认模型 */
  setDefaultModel(key: ModelKey): void {
    this.defaultModelKey = key
  }

  /** 解析模型 key → LLMConfig */
  private resolveModel(key?: string): LLMConfig {
    const modelKey = key || this.defaultModelKey
    if (!modelKey) {
      throw new Error('No model key specified and no default set')
    }

    const [providerId, model] = modelKey.split('::')
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    return {
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      model: model || provider.models[0],
    }
  }

  /** 获取/缓存 OpenAI 客户端 */
  private getClient(apiKey: string, baseURL: string): OpenAI {
    const cacheKey = `${baseURL}::${apiKey}`
    let client = this.clientCache.get(cacheKey)
    if (!client) {
      client = new OpenAI({ apiKey, baseURL })
      this.clientCache.set(cacheKey, client)
    }
    return client
  }

  /** 组合 AbortSignal + 超时 */
  private withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const onCallerAbort = () => ctrl.abort(signal!.reason)
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    if (ms > 0) {
      timer = setTimeout(
        () => ctrl.abort(new Error(`LLM request timed out after ${Math.round(ms / 1000)}s`)),
        ms
      )
      timer.unref?.()
    }

    return {
      signal: ctrl.signal,
      cleanup: () => {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onCallerAbort)
      },
    }
  }

  /** 非流式对话 */
  async chat(request: ChatRequest): Promise<string> {
    const cfg = this.resolveModel(request.modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)
    const { signal, cleanup } = this.withTimeout(request.signal, request.timeoutMs)

    try {
      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: cfg.model,
        messages: request.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content as any
        })),
      }
      if (request.temperature !== undefined) params.temperature = request.temperature
      if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens

      const response = await client.chat.completions.create(params, { signal })
      const raw = response.choices[0]?.message?.content || ''
      return raw.replace(THINK_TAG_RE, '').trim() || raw.trim()
    } finally {
      cleanup()
    }
  }

  /** 流式对话 */
  async chatStream(request: ChatRequest, callbacks: ChatStreamCallbacks): Promise<string> {
    const cfg = this.resolveModel(request.modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)
    const { signal, cleanup } = this.withTimeout(request.signal, request.timeoutMs)

    try {
      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: cfg.model,
        stream: true,
        messages: request.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content as any
        })),
      }
      if (request.temperature !== undefined) params.temperature = request.temperature
      if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens

      const stream = await client.chat.completions.create(params, { signal })

      let fullRaw = ''
      const filter = new ThinkFilter()

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || ''
        if (!delta) continue

        fullRaw += delta
        const clean = filter.feed(delta)
        if (clean) callbacks.onChunk(clean)
      }

      const final = filter.flush()
      if (final) callbacks.onChunk(final)

      const result = fullRaw.replace(THINK_TAG_RE, '').trim() || fullRaw.trim()
      callbacks.onDone?.(result)
      return result
    } catch (err) {
      callbacks.onError?.(err as Error)
      throw err
    } finally {
      cleanup()
    }
  }

  /** 生成嵌入向量 */
  async embed(text: string, modelKey?: string): Promise<number[]> {
    const cfg = this.resolveModel(modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)

    const response = await client.embeddings.create({
      model: cfg.model,
      input: text,
    })

    // 健壮性检查：某些 OpenAI 兼容 API 不支持 embeddings 或返回非标准格式
    if (!response?.data?.[0]?.embedding) {
      throw new Error(
        `Embedding API returned unexpected response format (model: ${cfg.model}). ` +
        `Ensure the model supports embeddings. Response: ${JSON.stringify(response).slice(0, 200)}`
      )
    }

    return response.data[0].embedding
  }

  /** 语音转文字（使用 OpenAI 兼容的 /audio/transcriptions 接口） */
  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    language?: string,
    modelKey?: string
  ): Promise<string> {
    const cfg = this.resolveModel(modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)

    // 根据 MIME 类型确定文件扩展名
    const ext = mimeType.includes('webm') ? 'webm'
      : mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mp3') ? 'mp3'
      : mimeType.includes('wav') ? 'wav'
      : 'webm'

    // 使用 OpenAI SDK 的 toFile 工具将 Buffer 转为 File 对象
    const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType })

    const params: OpenAI.Audio.Transcriptions.TranscriptionCreateParams = {
      file,
      model: 'whisper-1',
      ...(language ? { language } : {}),
    }

    const response = await client.audio.transcriptions.create(params)
    return response.text || ''
  }
}

// ── 单例 ──
export const llm = new LLMProvider()
