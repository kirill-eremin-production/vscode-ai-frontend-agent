# Компонентная библиотека (атомы)

Минимальный набор переиспользуемых React-атомов для webview'а. Заведена в #0016, чтобы следующие задачи (`#0017`–`#0023`) собирались из одного словаря, а не повторяли базовое.

## Что есть

| Компонент      | Назначение                                                                     |
| -------------- | ------------------------------------------------------------------------------ |
| `Button`       | Основная кнопка: 4 варианта × 2 размера, иконки слева/справа, loading.         |
| `IconButton`   | Иконка-only кнопка. `aria-label` обязателен в типе (TS-проверка).              |
| `Spinner`      | Крутящийся индикатор. Цвет — `currentColor`, размеры `xs/sm/md`.               |
| `LoadingState` | Spinner + подпись (US-23 «Архитектор думает…»). С `role="status"`.             |
| `Skeleton`     | Серый плейсхолдер с пульсацией. Варианты `text/line/block`.                    |
| `Badge`        | Пилюль-индикатор: `neutral/accent/danger/warning/success`.                     |
| `Panel`        | Карточка с фоном `surface-elevated` и опциональным `header` + `headerActions`. |
| `Collapsible`  | Аккордеон поверх Radix. Управляемый/неуправляемый.                             |
| `EmptyState`   | Крупная иконка + заголовок + описание + опц. CTA.                              |
| `Avatar`       | Круг/квадрат с иконкой роли. Цвет — из `--color-role-*`.                       |
| `Tooltip`      | Обёртка над `@radix-ui/react-tooltip`.                                         |

Иконки ролей — `roleIcons` (Product → `Package`, Architect → `Compass`, User → `User`, System → `Cog`). Один источник правды для аватаров и канваса.

## Импорт

```ts
import { Button, Spinner, Avatar } from '@shared/ui';
```

Глубокие импорты (`@shared/ui/Button`) использовать **не нужно** — барель в `index.ts` намеренно скрывает раскладку файлов.

## Как добавить новый атом

1. **Файл компонента** в `src/webview/shared/ui/<Name>.tsx`. Чистая функция от пропсов, никакого `useRunsStore`/`api` внутри. Имя файла = имя экспорта.
2. **Стили** — Tailwind utility-классы поверх токенов из [src/webview/app/app.css](../../app/app.css). Цвета — только через `bg-surface`/`text-foreground` или `var(--vscode-*)` напрямую. Никаких хардкод-hex.
3. **Стори-файл** рядом: `<Name>.stories.tsx`. Минимум — `Default` story; для compound-компонентов — отдельные истории на ключевые варианты.
4. **Реэкспорт** — добавить в [`index.ts`](./index.ts) (компонент + публичные типы).
5. **Прогнать Storybook** локально (`npm run storybook`) и проверить во всех трёх темах через toolbar-аддон.

## Storybook

- `npm run storybook` — dev-сервер на http://localhost:6006.
- `npm run build-storybook` — статический билд в `storybook-static/`.
- Builder — Vite (только для Storybook, прод webview по-прежнему собирается esbuild'ом).
- Темы переключаются в toolbar'е сверху (Dark Modern / Light Modern / High Contrast). Под капотом — `data-vscode-theme` на `<html>` + мок-переменные в [.storybook/vscode-themes.css](../../../../.storybook/vscode-themes.css).

## Что НЕ кладём в эту папку

- Бизнес-компоненты (RunDetails, RunList, формы создания) — они в `features/`.
- Layout-компоненты приложения (AppShell) — это `app/` или отдельный `widgets/`.
- Доменные хелперы (форматирование цены, парсинг tool-результатов) — в `shared/runs/` или отдельных модулях.

Эта папка — только примитивы UI без знания о домене.

## Visual regression

Не настроен — отдельный будущий тикет. Структура сторис готова к подключению (Chromatic / Playwright snapshots) — в каждой стори фиксированный набор `args`, без рандома.
