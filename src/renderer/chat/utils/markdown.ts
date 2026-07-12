/**
 * Markdown 渲染配置
 *
 * 使用 markdown-it + highlight.js 实现代码高亮、表格、链接等功能。
 * 代码块支持复制和预览（HTML/SVG）功能。
 * 流式渲染优化：缓存渲染结果，避免重复渲染完整内容。
 */

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'

// ── 可预览的语言 ──
const PREVIEWABLE_LANGS = ['html', 'svg', 'xml']

// ── 创建 markdown-it 实例 ──
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    const escapedCode = md.utils.escapeHtml(str)
    const langLower = (lang || '').toLowerCase()
    const isPreviewable = PREVIEWABLE_LANGS.includes(langLower)

    let highlighted: string
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {
        highlighted = escapedCode
      }
    } else {
      highlighted = escapedCode
    }

    // 构建带工具栏的代码块
    const langLabel = lang || 'text'
    const rawEncoded = encodeURIComponent(str)
    const toolbar = `<div class="code-toolbar">
      <span class="code-lang">${langLabel}</span>
      <div class="code-actions">
        <button class="code-btn code-copy-btn" data-raw="${rawEncoded}" title="复制代码">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制</span>
        </button>
        ${isPreviewable ? `<button class="code-btn code-preview-btn" data-raw="${rawEncoded}" data-lang="${langLower}" title="预览结果">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>预览</span>
        </button>` : ''}
      </div>
    </div>`

    return `<div class="code-block-wrapper" data-lang="${langLower}">${toolbar}<pre class="code-block"><code class="hljs language-${lang || 'text'}">${highlighted}</code></pre></div>`
  }
})

// ── 自定义渲染规则 ──

// 链接：添加 target="_blank" 和 rel="noopener"
const defaultLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  const token = tokens[idx]
  const targetIndex = token.attrIndex('target')
  const relIndex = token.attrIndex('rel')

  if (targetIndex < 0) {
    token.attrPush(['target', '_blank'])
  } else {
    token.attrs![targetIndex][1] = '_blank'
  }

  if (relIndex < 0) {
    token.attrPush(['rel', 'noopener noreferrer'])
  } else {
    token.attrs![relIndex][1] = 'noopener noreferrer'
  }

  return defaultLinkOpen(tokens, idx, options, env, self)
}

// 表格：添加 class
md.renderer.rules.table_open = function() {
  return '<div class="table-wrapper"><table class="md-table">'
}

md.renderer.rules.table_close = function() {
  return '</table></div>'
}

// 行内代码：添加 class
md.renderer.rules.code_inline = function(tokens, idx) {
  const content = md.utils.escapeHtml(tokens[idx].content)
  return `<code class="inline-code">${content}</code>`
}

// ── 渲染缓存（减少流式渲染时的重复计算）──
const renderCache = new Map<string, string>()
const CACHE_MAX_SIZE = 50

/**
 * 渲染 Markdown 为 HTML
 * 带缓存，流式渲染时避免重复渲染完整内容
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''

  // 检查缓存
  const cached = renderCache.get(text)
  if (cached !== undefined) return cached

  // 渲染
  const html = md.render(text)

  // 更新缓存
  if (renderCache.size >= CACHE_MAX_SIZE) {
    // 清理最早的缓存项
    const firstKey = renderCache.keys().next().value
    if (firstKey) renderCache.delete(firstKey)
  }
  renderCache.set(text, html)

  return html
}

/**
 * 清除渲染缓存
 */
export function clearMarkdownCache(): void {
  renderCache.clear()
}

/**
 * 获取 highlight.js 支持的语言列表
 */
export function getSupportedLanguages(): string[] {
  return hljs.listLanguages()
}
