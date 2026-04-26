import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

/**
 * Storybook конфиг. Builder — Vite (хотя продакшен webview собирается esbuild'ом):
 * SB официально не поддерживает esbuild-builder, а Vite в проекте всё равно
 * понадобился бы только для dev-сервера сторис. Это devDependency-only,
 * на продакшен-бандл webview не влияет.
 *
 * Tailwind 4 подключается через `@tailwindcss/vite` — тот же `app.css` из
 * #0015 импортируется в `preview.tsx`, чтобы атомы в сторис выглядели
 * один в один с боевым webview.
 *
 * Glob расширен на `features/` (#0041): сторис фичи `chat` показывает,
 * как лента выглядит при N>2 участниках. Для этого пришлось добавить
 * resolve-алиасы — фичевые компоненты импортируют `@shared/...`
 * (см. `tsconfig.webview.json#paths`), и Vite сам по себе их не
 * разрешает без `vite-tsconfig-paths` или явных alias'ов.
 */
const config: StorybookConfig = {
  stories: [
    '../src/webview/shared/ui/**/*.stories.@(ts|tsx)',
    '../src/webview/features/**/*.stories.@(ts|tsx)',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (viteConfig) =>
    mergeConfig(viteConfig, {
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: {
          '@app': path.resolve(__dirname, '../src/webview/app'),
          '@features': path.resolve(__dirname, '../src/webview/features'),
          '@shared': path.resolve(__dirname, '../src/webview/shared'),
        },
      },
    }),
};

export default config;
