---
id: 0046
title: Панель «Встречи» — карточки сессий рана
status: done
created: 2026-04-26
---

## Context

Хронологический журнал встреч (#0029) — лента сессий рана с участниками, источником входа, временем и статусом. Это новая панель в side-area (рядом или вместо текущей sessions panel).

## Acceptance criteria

- Новая фича `src/webview/features/meetings/` с компонентом `MeetingsPanel`.
- Панель показывает все сессии текущего рана, отсортированные по `startedAt` desc (свежие сверху).
- Карточка встречи включает:
  - Аватары/иконки `participants` (горизонтальный ряд).
  - `inputFrom` — пометка «← user» / «← product» / etc. визуально отличимо от participants.
  - Время старта (`HH:MM` или относительное «5m ago»).
  - Статус: `active` (зелёная точка) / `finished` (нейтрально) / `paused` (заглушка под #0052).
  - Превью первого/последнего сообщения (одна строка, truncate).
- Клик по карточке → drill-in в чат-таб этой сессии (используя существующий механизм навигации; поведение такое же, как drill из canvas).
- Live-обновление: новые сессии и изменения статуса появляются без перезагрузки.
- Решение про «sessions panel рядом или вместо»: на этой итерации **рядом** (новый таб/секция в side-area). Удаление старой sessions panel — будущая задача после фидбека.
- Storybook stories: пустой ран, ран с 5 сессиями включая активную и paused.

## Implementation notes

- Не делать поиск/фильтр/экспорт.
- prev/next ссылки в карточке — отдельная задача #0047.
- Иконки ролей переиспользовать из #0041.

## Related

- Подзадача #0029.
- Зависит от: #0034, #0035.
- Блокирует: #0047.

## Outcome

Реализована новая фича `src/webview/features/meetings/`: панель «Журнал
встреч» как второй таб правой side-area рядом с «Сессиями». Карточки
сортируются по `createdAt` desc, показывают аватары участников, пометку
`← inputFrom`, относительное/абсолютное время, статус
(`active`/`finished`/заглушка `paused`) и однострочное превью; клик
проваливает в чат-таб выбранной сессии (`drillIntoSession`). Per-run
выбор таба persist'ится через UI-преф `sidePanel.tab.<runId>`.

Превью per-session ограничено просматриваемой сессией (chat живёт в
store только для неё) — для остальных карточек fallback «Встреча N».
Полное per-session preview — отдельной задачей через серверное поле
`lastMessagePreview`. Реальный paused-визуал и иконка появятся в #0052.

Ключевые файлы:

- `src/webview/features/meetings/ui/MeetingsPanel.tsx`,
  `MeetingCard.tsx`, `MeetingsPanel.stories.tsx`.
- `src/webview/features/meetings/lib/format.ts` (+ unit-тесты).
- `src/webview/shared/runs/store.ts` — `SidePanelTab`,
  `setSidePanelTab`, `selectSidePanelTab`, persist через `uiPrefs`.
- `src/webview/features/sessions-panel/ui/SessionsPanel.tsx` — общий
  tab-strip.
- `src/webview/app/shell/AppShell.tsx` — переключение секций.
- `tests/user-stories.md` — US-45.
- `tests/e2e/specs/tc-53-meetings-panel-cards.md` — ручной TC.

Коммиты: `20f0c23` (impl), done-коммит ниже (review без замечаний).
