---
id: 0042
title: Canvas — заменить flow-layout на hierarchy-layout
status: done
created: 2026-04-26
---

## Context

Из #0028: canvas из flow-графа становится org-chart. Кубики ролей расположены по уровням, между уровнями — статичные тонкие линии-«репортинги», стрелки коммуникации убираются.

## Acceptance criteria

- В `src/webview/features/canvas/` модуль layout заменён: вместо текущего flow-расчёта позиций — hierarchy-layout.
- Позиции кубиков детерминированы по `levelOf(role)` (#0033): один кубик на роль, уровень по вертикали, центр по горизонтали.
- Между уровнями — статичные тонкие линии-«репортинги» (SVG line, без стрелок). Рисуются один раз на маунт, не на каждый poll-tick.
- Все edge-related данные (стрелки коммуникации между кубиками, `bridgeSessionId` на edges) удалены из layout-модели. Если `bridgeSessionId` нужен где-то ещё — он уже в session-метаданных после #0035.
- Кубики не перетаскиваются (никакого DnD).
- Drill-resolver (`drill-resolver.ts`) не меняется — owner-based матчинг работает как был.
- `data-canvas-drill-session` контракт сохранён на `<g>` каждого кубика.
- Existing unit-тесты на drill-resolver проходят без изменений.
- Новые unit на hierarchy-layout: для трёх ролей возвращает три позиции на разных y, одинаковом x; для двух — корректно сжимает.

## Implementation notes

- User в этой задаче пока **не** рисуется (это #0043). На canvas сейчас 3 кубика: product, architect, programmer.
- Анимация коммуникации поверх (#0025) — **удаляется**. Если она где-то подписана на edge-данные — отвязать. Возврат анимации поверх иерархии — отдельная будущая задача.

## Related

- Подзадача #0028.
- Зависит от: #0033.
- Блокирует: #0043, #0044, #0045.

## Outcome

- Canvas стал org-chart'ом: [src/webview/features/canvas/layout.ts](../src/webview/features/canvas/layout.ts) полностью переписан на hierarchy-layout, edge-модель и анимации удалены, `flashes.ts/.test.ts` снесены вместе с edge-flash CSS в [src/webview/app/app.css](../src/webview/app/app.css).
- Иерархия ролей вынесена в [src/webview/features/canvas/hierarchy.ts](../src/webview/features/canvas/hierarchy.ts) (локальная webview-копия `HIERARCHY/levelOf` — синхронизация с extension-копией поддерживается комментарием).
- [src/webview/features/canvas/ui/RunCanvas.tsx](../src/webview/features/canvas/ui/RunCanvas.tsx) рисует тонкие статичные линии-«репортинги» через `CanvasReportingLineView`; drill-in по кубику и `data-canvas-drill-session` сохранены, добавлен `data-canvas-level`.
- US-42 в [tests/user-stories.md](../tests/user-stories.md), ручной TC-49 в [tests/e2e/specs/tc-49-canvas-hierarchy-layout.md](../tests/e2e/specs/tc-49-canvas-hierarchy-layout.md). Старые TC-35/36/38 (handoff-стрелки и flash-анимация) остаются неактуальными — будут переработаны в #0045. Коммиты: f4aa783 (impl), review/done — этот.
