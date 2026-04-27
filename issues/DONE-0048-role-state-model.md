---
id: 0048
title: Модель состояния роли — idle/busy/awaiting_input
status: done
created: 2026-04-26
---

## Context

Для координации между сессиями (#0031) нужно знать, занята ли роль прямо сейчас. Это derived-состояние из активных сессий и pending meeting-requests, не отдельный persisted-флаг.

## Acceptance criteria

- Чистая функция `roleStateFor(role, runState): RoleState` где `RoleState = {kind: 'idle'} | {kind: 'busy', sessionId} | {kind: 'awaiting_input', meetingRequestId}`.
- Алгоритм:
  - Если в run есть pending `MeetingRequest` где `requesterRole === role` → `awaiting_input(meetingRequestId)`.
  - Иначе если есть активная сессия, в которой роль — участник, и последнее сообщение **не** от этой роли (то есть от неё ждут ответа) → `busy(sessionId)`.
  - Иначе → `idle`.
- Селектор `selectRoleStates(runState): Record<Role, RoleState>` для всех ролей сразу.
- В этой задаче `MeetingRequest` ещё не существует — функция принимает их как параметр (пустой массив пока). Интеграция реальных данных — в #0049/#0050.
- Unit:
  - Все idle для пустого рана.
  - busy с активной сессией где последнее сообщение от другого участника.
  - idle если последнее сообщение от самой роли (она ответила, ждёт уже не она).
  - awaiting_input при наличии pending-request.

## Implementation notes

- Жить в `src/extension/entities/run/role-state.ts` (или подобном).
- Не путать с состояниями кубика на canvas (#0044) — там `working`/`awaiting_user`/`idle` в UX-терминах. Связь: `busy` ≈ `working`, `awaiting_input` ≈ `paused` (см. #0052).

## Related

- Подзадача #0031.
- Блокирует: #0050, #0052.

## Outcome

Реализовано в `src/extension/entities/run/role-state.ts`: чистая
`roleStateFor(role, runState)` с discriminated union
`idle/busy/awaiting_input` и селектор `selectRoleStates(runState):
Record<Role, RoleState>` по всей `HIERARCHY`. `MeetingRequest`
объявлен локальным structural-интерфейсом (`id`/`requesterRole`/
`status`/`createdAt`) — реальный storage подключится в #0049 без
правки контракта. Юниты в `role-state.test.ts` покрывают все ветки
AC + граничные случаи (приоритет awaiting_input над busy, выбор
самого старого pending по `createdAt`, финальные статусы сессий
не делают busy, пустой чат, не-участник). Зафиксировано: US-47,
TC-55. Коммит реализации — 4cbe411.
