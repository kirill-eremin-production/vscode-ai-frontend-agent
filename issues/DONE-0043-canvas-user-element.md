---
id: 0043
title: Canvas — User как отдельный визуальный элемент сверху иерархии
status: done
created: 2026-04-26
---

## Context

User — заказчик, не участник иерархии агентов. На canvas он рисуется отдельно (аватар/иконка), не «таким же кубиком».

## Acceptance criteria

- Над уровнем product на canvas — отдельный визуальный элемент User (круглый аватар или иконка человека). Размер и стиль отличаются от кубиков агентов.
- Линия-«репортинг» от User к product — такая же тонкая статичная.
- Клик по User → drill-in в корневую user↔product сессию рана (та, у которой `inputFrom === 'user'` и нет `prev`).
- Если корневой сессии не нашлось (edge-case) — клик no-op, без падений.
- `data-canvas-drill-session` проставлен на User-элементе с id корневой сессии.
- E2E (или unit на resolver): клик по User-элементу триггерит drill в корневую сессию.

## Implementation notes

- Идентифицировать корневую сессию: `prev.length === 0 && inputFrom === 'user'`. Должна быть ровно одна (но если их вдруг несколько — берём самую раннюю по `startedAt`).
- Аватар User — пока статичная иконка (lucide-react `User` или подобная), без аватара профиля.

## Related

- Подзадача #0028.
- Зависит от: #0035 (нужен `inputFrom`), #0042.

## Outcome

Реализовано в df2828c. На canvas над верхним кубиком рисуется
круглый User-элемент (lucide `User`, диаметр 48 vs NODE_H=96), к
продакту идёт тонкая статичная линия того же стиля, что и
межуровневые. Drill-in по клику/Enter ведёт в корневую сессию
(`inputFrom='user'`, пустой `prev`); резолвер —
`resolveUserDrillSession` в [drill-resolver.ts](../src/webview/features/canvas/drill-resolver.ts);
layout — [layout.ts](../src/webview/features/canvas/layout.ts);
рендер — `CanvasUserView` в [RunCanvas.tsx](../src/webview/features/canvas/ui/RunCanvas.tsx).
Если корневой нет — `data-canvas-drill-session` пуст и клик —
no-op. Покрыто unit-тестами (`drill-resolver.test.ts`,
`layout.test.ts`), US-43 и ручным TC-50. Ревью замечаний не
выявило.
