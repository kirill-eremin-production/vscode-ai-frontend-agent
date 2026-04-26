---
id: 0052
title: UI — состояние paused на кубике, в карточке встречи, inbox запросов
status: open
created: 2026-04-26
---

## Context

Когда роль в `awaiting_input` (#0048) — пользователь должен это видеть. Это завершающий UI-кусок системы meeting-request.

## Acceptance criteria

- **Canvas (#0044 расширяется):**
  - Новое состояние кубика `paused` — отличимо от `idle` и `working` (например, иконка часов + неактивный фон).
  - Маппинг: `RoleState.kind === 'awaiting_input'` → `paused`.
  - Caption под кубиком: «ждёт ответа от <requesteeRole>».
- **Карточка встречи (#0046 расширяется):**
  - Если сессия — `contextSessionId` для pending-request → статус `paused` с пометкой «ждёт ответа от <role>».
- **Inbox запросов:**
  - Новая секция в side-area «Pending requests» (или внутри панели «Встречи»): список pending meeting-requests рана.
  - Каждый элемент: «<requesterRole> → <requesteeRole>: <короткий preview message>». Клик → drill-in в `contextSessionId`.
  - Live-обновление: новые запросы появляются, резолвнутые исчезают.
- Storybook: state с paused-кубиком и непустым inbox.

## Implementation notes

- Не делать управления request'ами вручную (отмена/принудительный резолв) — это будущее.
- Все три места берут данные из одного селектора `selectRoleStates` + `getPendingRequests`.

## Related

- Подзадача #0031.
- Зависит от: #0044, #0046, #0048, #0049.
