import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@agent': resolve(__dirname, 'agent'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          pet: resolve(__dirname, 'src/preload/pet.ts'),
          chat: resolve(__dirname, 'src/preload/chat.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          skills: resolve(__dirname, 'src/preload/skills.ts'),
          memory: resolve(__dirname, 'src/preload/memory.ts'),
          plugins: resolve(__dirname, 'src/preload/plugins.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          pet: resolve(__dirname, 'src/renderer/pet/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          skills: resolve(__dirname, 'src/renderer/skills/index.html'),
          memory: resolve(__dirname, 'src/renderer/memory/index.html'),
          plugins: resolve(__dirname, 'src/renderer/plugins/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@pet': resolve(__dirname, 'src/renderer/pet'),
        '@chat': resolve(__dirname, 'src/renderer/chat')
      }
    },
    plugins: [vue()]
  }
})
