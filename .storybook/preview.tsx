import type { Preview, Decorator } from '@storybook/react-vite';
import * as React from 'react';
import { useEffect } from 'react';
import '../src/webview/app/app.css';
import './vscode-themes.css';

/**
 * Decorator переключения темы. Ставит `data-vscode-theme` на `<html>` —
 * это селектор, под которым в `vscode-themes.css` лежат три набора
 * `--vscode-*` переменных. Меняем атрибут — мгновенно перерисовываются
 * все компоненты, как и в боевом webview при смене темы пользователя.
 *
 * Useeffect, а не прямой `document.documentElement.setAttribute` в теле
 * decorator'а, потому что Storybook монтирует/размонтирует историю
 * многократно — useEffect-cleanup даёт корректное поведение в SSR-режиме
 * docs add-on'а.
 */
function VscodeThemeBoundary({ theme, children }: { theme: string; children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-vscode-theme', theme);
  }, [theme]);
  return <>{children}</>;
}

const withVscodeTheme: Decorator = (Story, context) => {
  const theme = (context.globals.vscodeTheme as string | undefined) ?? 'dark';
  return (
    <VscodeThemeBoundary theme={theme}>
      <Story />
    </VscodeThemeBoundary>
  );
};

const preview: Preview = {
  parameters: {
    controls: { expanded: true },
    backgrounds: { disable: true },
  },
  globalTypes: {
    vscodeTheme: {
      description: 'VS Code theme',
      defaultValue: 'dark',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark Modern' },
          { value: 'light', title: 'Light Modern' },
          { value: 'hc-dark', title: 'High Contrast' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withVscodeTheme],
};

export default preview;
