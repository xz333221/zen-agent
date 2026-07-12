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
    let timedOut = false

    const onCallerAbort = () => {
      console.warn(`[LLM] Request aborted by caller: ${signal!.reason}`)
      ctrl.abort(signal!.reason)
    }
    if (signal) {
      if (signal.aborted) {
        console.warn('[LLM] Request already aborted before start')
        ctrl.abort(signal.reason)
      }
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    if (ms > 0) {
      timer = setTimeout(
        () => {
          timedOut = true
          const errMsg = `LLM request timed out after ${Math.round(ms / 1000)}s`
          console.error(`[LLM] ⏱ TIMEOUT: ${errMsg}`)
          ctrl.abort(new Error(errMsg))
        },
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
      isTimedOut: () => timedOut,
    }
  }

  /** 非流式对话 */
  async chat(request: ChatRequest): Promise<string> {
    const cfg = this.resolveModel(request.modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)
    const timeoutCtx = this.withTimeout(request.signal, request.timeoutMs)
    const signal = timeoutCtx.signal
    const cleanup = timeoutCtx.cleanup

    const startTime = Date.now()
    const msgCount = request.messages.length
    const timeoutStr = request.timeoutMs ? `${request.timeoutMs / 1000}s` : '8min(default)'
    console.log(`[LLM] chat() → model=${cfg.model}, msgs=${msgCount}, timeout=${timeoutStr}`)

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
      const result = raw.replace(THINK_TAG_RE, '').trim() || raw.trim()
      const elapsed = Date.now() - startTime
      console.log(`[LLM] chat() ✓ ${elapsed}ms, response=${result.length}chars`)
      return result
    } catch (err) {
      const elapsed = Date.now() - startTime
      const error = err as Error
      const isTimeout = timeoutCtx.isTimedOut?.() ?? false
      console.error(`[LLM] chat() ✗ ${elapsed}ms, timeout=${isTimeout}, error:`, error?.message || error)
      if (error?.stack) {
        console.error('[LLM] chat() stack:', error.stack.split('\n').slice(0, 5).join('\n'))
      }
      throw err
    } finally {
      cleanup()
    }
  }

  /** 流式对话 */
  async chatStream(request: ChatRequest, callbacks: ChatStreamCallbacks): Promise<string> {
    const cfg = this.resolveModel(request.modelKey)
    const client = this.getClient(cfg.apiKey, cfg.baseURL)
    const timeoutCtx = this.withTimeout(request.signal, request.timeoutMs)
    const signal = timeoutCtx.signal
    const cleanup = timeoutCtx.cleanup

    const startTime = Date.now()
    const msgCount = request.messages.length
    const timeoutStr = request.timeoutMs ? `${request.timeoutMs / 1000}s` : '8min(default)'
    console.log(`[LLM] chatStream() → model=${cfg.model}, msgs=${msgCount}, timeout=${timeoutStr}`)

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
      let chunkCount = 0
      const filter = new ThinkFilter()

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || ''
        if (!delta) continue

        chunkCount++
        fullRaw += delta
        const clean = filter.feed(delta)
        if (clean) callbacks.onChunk(clean)
      }

      const final = filter.flush()
      if (final) callbacks.onChunk(final)

      const result = fullRaw.replace(THINK_TAG_RE, '').trim() || fullRaw.trim()
      const elapsed = Date.now() - startTime
      console.log(`[LLM] chatStream() ✓ ${elapsed}ms, chunks=${chunkCount}, response=${result.length}chars`)
      callbacks.onDone?.(result)
      return result
    } catch (err) {
      const elapsed = Date.now() - startTime
      const error = err as Error
      const isTimeout = timeoutCtx.isTimedOut?.() ?? false
      console.error(`[LLM] chatStream() ✗ ${elapsed}ms, timeout=${isTimeout}, error:`, error?.message || error)
      if (error?.stack) {
        console.error('[LLM] chatStream() stack:', error.stack.split('\n').slice(0, 5).join('\n'))
      }
      callbacks.onError?.(error)
      throw err
    } finally {
      cleanup()
    }
  }

  /** 生成嵌入向量 */
  async embed(text: string, modelKey?: string): Promise<number[]> {
    const cfg = this.resolveModel(modelKey)
    const textLen = text.length
    console.log(`[LLM] embed() → model=${cfg.model}, textLen=${textLen}`)

    // 检测是否为 MiniMax API（主动使用原生格式，避免 OpenAI 格式的不必要尝试）
    const isMiniMaxAPI = cfg.baseURL.toLowerCase().includes('minimax')

    // 1. 如果不是 MiniMax API，先尝试 OpenAI 兼容格式
    if (!isMiniMaxAPI) {
      const client = this.getClient(cfg.apiKey, cfg.baseURL)
      try {
        const response = await client.embeddings.create({
          model: cfg.model,
          input: text,
        })

        if (response?.data?.[0]?.embedding) {
          console.log(`[LLM] embed() ✓ dim=${response.data[0].embedding.length}`)
          return response.data[0].embedding
        }

        // 检查是否为 MiniMax 风格的响应（vectors + base_resp）
        const raw = response as unknown as { vectors?: number[][]; base_resp?: { status_msg?: string } }
        if (raw?.vectors?.[0]) {
          console.log(`[LLM] embed() ✓ (MiniMax-style response) dim=${raw.vectors[0].length}`)
          return raw.vectors[0]
        }

        throw new Error(
          `Embedding API returned unexpected response format (model: ${cfg.model}). ` +
          `Ensure the model supports embeddings. Response: ${JSON.stringify(response).slice(0, 200)}`
        )
      } catch (err) {
        // 2. 如果 OpenAI 格式失败，尝试 MiniMax 原生格式（使用 texts 参数）
        const errorMsg = err instanceof Error ? err.message : String(err)
        // 扩展检测条件：不仅检查 'texts'，还检查 'invalid params'、'vectors' 等 MiniMax 特征
        const shouldTryMiniMax = errorMsg.includes('texts') ||
          errorMsg.includes('missing required parameter') ||
          errorMsg.includes('invalid params') ||
          errorMsg.includes('vectors') ||
          errorMsg.includes('base_resp')

        if (shouldTryMiniMax) {
          console.warn(`[LLM] embed() OpenAI format failed (${errorMsg.slice(0, 100)}), trying MiniMax native format...`)
          return await this.embedWithMiniMaxFormat(cfg, text)
        }
        console.error(`[LLM] embed() ✗ error: ${errorMsg}`)
        throw err
      }
    }

    // 3. MiniMax API 直接使用原生格式
    return await this.embedWithMiniMaxFormat(cfg, text)
  }

  /** 使用 MiniMax 原生格式调用 embedding API */
  private async embedWithMiniMaxFormat(cfg: LLMConfig, text: string): Promise<number[]> {
    const baseUrl = cfg.baseURL.replace(/\/+$/, '')
    const url = `${baseUrl}/embeddings`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        texts: [text],
        type: 'db',  // MiniMax embedding 类型: db 或 query
      }),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(
        `MiniMax embedding API returned HTTP ${response.status}. ` +
        `Response: ${errText.slice(0, 200)}`
      )
    }

    const data = await response.json() as {
      vectors?: number[][]
      data?: Array<{ embedding?: number[] }>
      base_resp?: { status_code?: number; status_msg?: string }
    }

    // MiniMax 原生格式: { vectors: [[...]], base_resp: {...} }
    if (data?.vectors?.[0]) {
      return data.vectors[0]
    }

    // 某些 MiniMax 兼容端点可能返回 OpenAI 风格的 data 字段
    if (data?.data?.[0]?.embedding) {
      return data.data[0].embedding
    }

    // MiniMax 返回了错误响应（如 vectors: null + base_resp.status_msg: "invalid params"）
    if (data?.base_resp?.status_msg) {
      const statusMsg = data.base_resp.status_msg
      const statusCode = data.base_resp.status_code
      if (statusCode === 2013 || statusMsg.includes('invalid params')) {
        throw new Error(
          `MiniMax embedding API 返回参数错误 (status: ${statusCode}): "${statusMsg}"。` +
          `请检查设置中的嵌入模型是否正确配置（MiniMax 的嵌入模型应为 "embo-01"），` +
          `当前使用的模型是 "${cfg.model}"。如果这是聊天模型，请在设置中配置正确的嵌入模型。`
        )
      }
      throw new Error(
        `MiniMax embedding API error (status: ${statusCode}): ${statusMsg}. ` +
        `Model: ${cfg.model}. Response: ${JSON.stringify(data).slice(0, 200)}`
      )
    }

    throw new Error(
      `MiniMax embedding API returned unexpected response. ` +
      `Model: ${cfg.model}. Response: ${JSON.stringify(data).slice(0, 200)}`
    )
  }

  /** 语音转文字（使用 OpenAI 兼容的 /audio/transcriptions 接口） */
  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    language?: string,
    modelKey?: string
  ): Promise<string> {
    const cfg = this.resolveModel(modelKey)

    // 检查是否可能是 OpenAI 官方 API（只有 OpenAI 支持 /audio/transcriptions）
    const isOpenAI = cfg.baseURL.includes('openai.com') || cfg.baseURL.includes('api.openai')
    
    if (!isOpenAI) {
      throw new Error(
        '当前 LLM 服务商不支持语音识别（/audio/transcriptions 接口）。' +
        '语音识别需要使用 OpenAI 官方 API 或兼容的服务。' +
        '请在设置中配置 OpenAI 的 API Key 和 Base URL（https://api.openai.com/v1）。'
      )
    }

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

    try {
      const response = await client.audio.transcriptions.create(params)
      return response.text || ''
    } catch (err: any) {
      if (err?.status === 404) {
        throw new Error(
          '语音识别接口返回 404。当前 API 服务商不支持 /audio/transcriptions 端点。' +
          '语音识别需要 OpenAI 官方 API（https://api.openai.com/v1）。'
        )
      }
      throw err
    }
  }
}

// ── 单例 ──
export const llm = new LLMProvider()
