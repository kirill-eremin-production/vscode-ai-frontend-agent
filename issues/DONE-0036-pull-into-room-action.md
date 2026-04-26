---
id: 0036
title: pullIntoRoom + системное событие participant_joined
status: done
created: 2026-04-26
---

## Context

С массивом `participants` (#0034) нужен механизм добавлять роль в активную сессию. Это базовая операция для `team.invite` (#0037), `team.escalate` (#0038) и UI-кнопок в будущем.

## Acceptance criteria

- Новый action `pullIntoRoom(sessionId: SessionId, role: Role): void`:
  - Если `role` уже в `session.participants` — no-op (идемпотентно).
  - Иначе: добавляет роль в `participants`, persist, пишет в лог сессии системное событие `participant_joined` с полями `{role, at: ISOTimestamp}`.
- Тип системного события `participant_joined` добавлен в схему сообщений сессии (это системная запись, не chat-message; рендерится отдельным стилем — но сам рендер не в этой задаче).
- Подписчики live-state видят обновлённый `participants` после вызова (broadcast/refresh).
- Unit:
  - Добавление новой роли — `participants` обновился, событие записано.
  - Повторный вызов с той же ролью — no-op, событие не дублируется.
  - Запись в журнал сессии корректна и читается обратно.
- В этой задаче ещё нет интеграции с `meeting-request` (#0051) — pullIntoRoom вызывается напрямую, проверки занятости адресата нет.

## Implementation notes

- Где живёт: `src/extension/entities/run/session/` (или текущее место session-логики).
- Не передавать через action содержание сообщения. Сообщение пишет инициатор отдельно (`team.invite`/`escalate` сами составят первый месседж в комнату).
- На этой итерации нет тула `team.invite` — он в #0037. Здесь только action как кирпич.

## Related

- Подзадача #0030.
- Зависит от: #0034.
- Блокирует: #0037, #0038, #0051.

## Outcome

Реализовано: action `pullIntoRoom(runId, sessionId, role)` в
[storage.ts](../src/extension/entities/run/storage.ts) — идемпотентно
добавляет агентскую роль в `participants` и пишет в `tools.jsonl`
системное событие `{kind: 'participant_joined', at, role}`. Тип
добавлен в дискриминированный union `ToolEvent` (extension и webview).
В `buildTimeline` ([RunDetails.tsx](../src/webview/app/shell/RunDetails.tsx))
запись скрыта до отдельного рендера в #0046. Возвращает обновлённую
`RunMeta`: вызывающий код (#0037/#0038) сам сделает broadcast
`runs.updated` — следуем существующему паттерну `addParticipant` →
`broadcast` в `wire.ts`. Покрытие: unit-сюита `pullIntoRoom (#0036)`
(3 кейса), US-36, TC-43. Коммит реализации: 8ad8210.
