/**
 * 工具参数示例 — 共享数据源
 *
 * param-normalizer（报错 hint）和 nudge-engine（纠偏 8 提示）共用，
 * 避免两处示例文案漂移。
 */

/** 每个工具的正确 ACTION_INPUT 示例（文本 ReAct 协议） */
export const TOOL_PARAM_EXAMPLES: Record<string, string> = {
  terminal: 'ACTION_INPUT: {"command": "dir", "cwd": "e:\\\\project"}',
  file_reader: 'ACTION_INPUT: {"path": "e:\\\\project\\\\package.json"}',
  file_writer: 'ACTION_INPUT: {"path": "e:\\\\project\\\\test.txt", "content": "内容"}',
  file_edit: 'ACTION_INPUT: {"path": "e:\\\\project\\\\a.ts", "old_string": "foo()", "new_string": "bar()"}',
  web_search: 'ACTION_INPUT: {"query": "搜索关键词"}',
  file_search: 'ACTION_INPUT: {"query": "项目名"}',
  fetch_url: 'ACTION_INPUT: {"url": "https://example.com"}',
  open_url: 'ACTION_INPUT: {"url": "https://example.com"}',
  code_executor: 'ACTION_INPUT: {"code": "return 1 + 2"}',
}

/** 获取工具示例（无示例时返回 undefined） */
export function getToolParamExample(toolId: string): string | undefined {
  return TOOL_PARAM_EXAMPLES[toolId]
}
