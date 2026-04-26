---
id: 0050
title: meeting-resolver — резолв pending-запросов
status: open
created: 2026-04-26
---

## Context

Когда занятая роль освободилась, system должна посмотреть на pending meeting-requests к ней и поднять самый старый в комнату. Этот же модуль ловит deadlock'и.

## Acceptance criteria

- Новый модуль `src/extension/team/meeting-resolver.ts`.
- Функция `resolvePending(runId): Promise<ResolveResult[]>`:
  - Загружает все pending-requests + текущее `roleStateFor` всех ролей (#0048).
  - Для каждого pending-request: если `requesteeRole` сейчас `idle` — резолв.
  - Резолв = создать новую сессию-комнату с `participants: [requesterRole, requesteeRole]` и записать `message` из request как первое сообщение от `requesterRole`. (Эскалация цепочки — забота #0051; resolver работает с уже сформулированной парой.)
  - Установить request status `resolved`, заполнить `resolvedSessionId`.
- Deadlock detection: если для пары (A→B pending) существует обратный pending (B→A), оба request'а — `failed` со `failureReason: 'deadlock between A and B'`. Лог в output.
- Триггеры:
  - При завершении любой сессии — вызвать `resolvePending`.
  - При активации расширения — вызвать `resolvePending` после загрузки рана.
  - **Не** вызывать на каждом сообщении.
- Unit:
  - pending-request к idle-роли резолвится в новую сессию.
  - pending к busy-роли — остаётся pending.
  - Bidirectional pending → оба failed с диагностикой.
  - Несколько pending к одной роли — резолв самого старого (по `createdAt`), остальные ждут.

## Implementation notes

- При резолве создаётся новая сессия (а не reuse `contextSessionId`) — иначе теряется граница «эта переписка началась в ответ на тот запрос». `prev` новой сессии = `[contextSessionId]`.
- Race-conditions: на этой итерации не закладываемся, всё последовательно.

## Related

- Подзадача #0031.
- Зависит от: #0048, #0049, #0036 (создание сессии и pullIntoRoom).
- Блокирует: #0051.
