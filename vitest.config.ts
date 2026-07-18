import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // agent 模块大量 import electron（app.getPath 等），用 mock 替换
    alias: {
      electron: resolve(__dirname, 'tests/mocks/electron.ts')
    }
  },
  resolve: {
    alias: {
      '@agent': resolve(__dirname, 'agent'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  }
})
