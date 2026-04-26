import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // playwright-report/ и test-results/ — артефакты Playwright со
    // встроенными HTML/JSON, ESLint их парсить не должен (на больших
    // репортах упирается в память). out/ и node_modules/ — стандартные
    // build/deps игноры.
    ignores: [
      'out/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // .vscode-test/ — каталог скачанного VS Code для Playwright; внутри
      // тысячи bundled JS встроенных extensions, ESLint туда лезть не должен.
      '.vscode-test/**',
      // storybook-static/ — артефакт `npm run build-storybook`, тысячи
      // минифицированных JS/HTML, в lint не нужен.
      'storybook-static/**',
      '*.vsix',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },
  {
    files: ['src/extension/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // tests/e2e/test-extension/ — отдельный CommonJS extension, который
  // запускается вторым `--extensionDevelopmentPath` для перехвата
  // OpenRouter-запросов в e2e. Это .js, не .ts, и он намеренно использует
  // `require()` (его грузит сам VS Code как обычный node-модуль). Здесь
  // даём ему `node` globals и разрешаем require, чтобы общий конфиг
  // не подсвечивал родную CommonJS-семантику как ошибки.
  {
    files: ['tests/e2e/test-extension/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/webview/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: '19.2.5' },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  // .storybook/ — конфиг сборщика сторис. Лежит вне src/, поэтому
  // FSD-границы и правила webview к нему не применяются. Но preview.tsx
  // — React-файл с JSX, а main.ts/preview.tsx обращаются к Node-API
  // Storybook (см. mergeConfig из vite). Даём ему оба набора globals
  // и react-jsx, чтобы ESLint не подсвечивал «React is not defined» и
  // «process is not defined».
  {
    files: ['.storybook/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '19.2.5' } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  // ──────────────────────────────────────────────────────────────────────
  // FSD-границы через eslint-plugin-boundaries.
  //
  // Идея: каждый файл в src/* помечается «элементом» (app/pages/features/
  // shared/extension), и плагин проверяет, что импорты идут только в
  // разрешённых направлениях. Всё, что не описано явно, запрещено
  // (`default: 'disallow'`) — это даёт жёсткую защиту от случайных
  // протечек слоёв.
  //
  // Иерархия webview (сверху вниз, выше может импортировать ниже):
  //   app  →  pages  →  features  →  shared
  // Импорт «вверх» (например, shared → features) — запрещён.
  // Импорт между сиблингами одного слоя (feature A → feature B,
  // page A → page B) — тоже запрещён, чтобы не возникало неявных
  // связей внутри одного уровня.
  //
  // Extension host вынесен в отдельный элемент `extension`, и ему
  // запрещено импортировать что-либо из webview (и наоборот).
  // Это страхует от случайной утечки кода из Node-окружения в
  // браузерный бандл и обратно.
  // ──────────────────────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // Описание элементов: какой паттерн пути → какой тип элемента.
      // `mode: 'folder'` означает, что элементом считается папка целиком,
      // а `capture` извлекает имя слайса (нужно, чтобы различать
      // соседние фичи/страницы между собой).
      'boundaries/elements': [
        {
          type: 'webview-app',
          pattern: 'src/webview/app',
          mode: 'folder',
        },
        {
          type: 'webview-pages',
          pattern: 'src/webview/pages/*',
          mode: 'folder',
          capture: ['slice'],
        },
        {
          type: 'webview-features',
          pattern: 'src/webview/features/*',
          mode: 'folder',
          capture: ['slice'],
        },
        {
          type: 'webview-shared',
          pattern: 'src/webview/shared',
          mode: 'folder',
        },
        {
          type: 'extension',
          pattern: 'src/extension',
          mode: 'folder',
        },
      ],
      // TS-резолвер обязателен: без него плагин не умеет
      // достраивать `.ts`/`.tsx`-расширения в импортах вида
      // `./ui/PingButton` и считает их «неизвестными элементами».
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['tsconfig.extension.json', 'tsconfig.webview.json'],
          // В проекте два изолированных tsconfig (extension + webview),
          // и без этого флага TS-резолвер шлёт предупреждение про
          // «multiple projects» на каждый файл.
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      // Любой файл в src/* должен попасть под один из элементов выше.
      // Если нет — это либо опечатка в пути, либо забытое описание.
      'boundaries/no-unknown-files': 'error',
      // Импорт неизвестного элемента (например, относительный путь,
      // выводящий за границы src/) — тоже ошибка.
      'boundaries/no-unknown': 'error',
      // Главная проверка направлений импортов между слоями.
      // В v6 правило переименовано из `element-types` в `dependencies`.
      'boundaries/dependencies': [
        'error',
        {
          // Всё, что не разрешено явно ниже — запрещено.
          default: 'disallow',
          // v6-синтаксис:
          //  - `from`  — селектор-объект `{ type: '...' }` (или массив);
          //  - `allow` — массив policy-объектов `{ to: { type: '...' } }`
          //    (или один объект). policy внутри `allow` описывает, КУДА
          //    разрешено импортировать из источников, заданных в `from`.
          // При `default: 'disallow'` всё, что не описано здесь, запрещено.
          rules: [
            // Слой app — самый верх webview-иерархии.
            {
              from: { type: 'webview-app' },
              allow: [
                { to: { type: 'webview-pages' } },
                { to: { type: 'webview-features' } },
                { to: { type: 'webview-shared' } },
              ],
            },
            // Страницы могут собирать фичи и брать из shared,
            // но НЕ могут импортировать другие страницы или app.
            {
              from: { type: 'webview-pages' },
              allow: [{ to: { type: 'webview-features' } }, { to: { type: 'webview-shared' } }],
            },
            // Фичи изолированы друг от друга: им доступен только shared.
            // Если фиче нужна логика другой фичи — это сигнал поднять
            // её в shared/entities/widgets, а не импортировать сиблинга.
            {
              from: { type: 'webview-features' },
              allow: [{ to: { type: 'webview-shared' } }],
            },
            // Импорты внутри одного и того же элемента (shared → shared,
            // extension → extension) плагин не проверяет вообще — это
            // документированное поведение, поэтому отдельные правила
            // для интра-элементных связей здесь не нужны.
            //
            // Для extension host явных правил тоже нет: при `default:
            // 'disallow'` любой его импорт во внешний элемент (webview-*)
            // будет автоматически запрещён, а внутренние импорты —
            // разрешены как «внутри одного элемента».
          ],
        },
      ],
    },
  },
  prettier
);
