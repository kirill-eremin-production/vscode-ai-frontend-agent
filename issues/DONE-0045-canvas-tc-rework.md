---
id: 0045
title: E2E — дроп TC-39, новые TC на drill через кубики иерархии
status: done
created: 2026-04-26
---

## Context

После #0042 на canvas нет edge'ей коммуникации, поэтому TC-39 (drill через клик по edge) больше не применим. Нужны новые TC под кликабельные кубики иерархии.

## Acceptance criteria

- TC-39 удалён из тест-сьюта (или переименован/переписан под новый кейс — на усмотрение реализующего).
- Новые E2E:
  - Клик по кубику programmer во время его работы → открывается чат-таб на его текущей сессии.
  - Клик по idle-кубику architect → открывается последняя сессия architect в этом ране (lastViewedSession persistence из #0026).
  - Клик по элементу User → открывается корневая user↔product сессия.
- Селекторы используют `data-canvas-drill-session` (контракт сохранён).
- Активация через focus+Enter (как в текущем TC-39) — поддержать для a11y.
- Соответствующие user-stories обновлены (US-26..US-27 если они про edge → корректировать формулировки под кубики).

## Implementation notes

- Тестовый ран нужен с минимум двумя сессиями у одной из ролей, чтобы проверить «последняя сессия».
- Если `tc.md` или каталог TC обновляется — синхронно с кодом тестов.

## Related

- Подзадача #0028.
- Зависит от: #0042, #0043.

## Outcome

- TC-39 переписан под кубики иерархии: drill по architect cube + User-элементу через focus+Enter, селектор `data-canvas-drill-session`, проверка lastViewedSession (#0026). Edge-кейсы сняты вместе с edge'ями (#0042) — см. [tests/e2e/specs/tc-39-canvas-drill-in.spec.ts](../tests/e2e/specs/tc-39-canvas-drill-in.spec.ts).
- Кейс «working programmer cube → текущая bridge architect↔programmer» оформлен ручным TC-52 ([tests/e2e/specs/tc-52-canvas-programmer-cube-drill.md](../tests/e2e/specs/tc-52-canvas-programmer-cube-drill.md)) — программистский цикл в e2e пока без автоматизации.
- Контракт «несколько owned-сессий архитектора → drill в свежайшую» закрыт unit-тестом в [src/webview/features/canvas/drill-resolver.test.ts](../src/webview/features/canvas/drill-resolver.test.ts).
- US-26 помечена устаревшей, US-27 переформулирована вокруг кубиков и User-элемента в [tests/user-stories.md](../tests/user-stories.md).
- Реализация — коммит fbbe993, ревью без замечаний.
