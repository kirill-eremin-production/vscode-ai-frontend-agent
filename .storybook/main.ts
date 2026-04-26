import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

/**
 * Storybook конфиг. Builder — Vite (хотя продакшен webview собирается esbuild'ом):
 * SB официально не поддерживает esbuild-builder, а Vite в проекте всё равно
 * понадобился бы только для dev-сервера сторис. Это devDependency-only,
 * на продакшен-бандл webview не влияет.
 *
 * Tailwind 4 подключается через `@tailwindcss/vite` — тот же `app.css` из
 * #0015 импортируется в `preview.tsx`, чтобы атомы в сторис выглядели
 * один в один с боевым webview.
 */
const config: StorybookConfig = {
  stories: ['../src/webview/shared/ui/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  // Resolve-алиасы дублируем минимально: атомы из shared/ui в сторис
  // импортируем относительными путями, поэтому aliases.json пока хватает.
  viteFinal: async (viteConfig) =>
    mergeConfig(viteConfig, {
      plugins: [react(), tailwindcss()],
    }),
};

export default config;
