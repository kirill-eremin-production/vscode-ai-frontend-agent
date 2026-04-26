---
id: 0038
title: Тул team.escalate — приглашение через уровни иерархии
status: open
created: 2026-04-26
---

## Context

Когда программист хочет ответ от продакта, между ними обязательно должен быть архитектор. Тул `team.escalate` сам докидывает все промежуточные уровни в сессию.

## Acceptance criteria

- Новый тул: `team.escalate(targetRole: Role, message: string)`.
- Поведение:
  - `caller` = роль текущего агента.
  - Цепочка: `[caller, ...rolesBetween(caller, targetRole), targetRole]` (использует #0033).
  - Для каждой роли в цепочке кроме `caller` — вызывает `pullIntoRoom(currentSessionId, role)` (#0036).
  - Записывает `message` как сообщение от `caller` в сессию.
  - Возвращает `{sessionId, participants, chain}`.
- Если `caller === targetRole` или `areAdjacent(caller, targetRole)` — возвращает ошибку «escalate не нужен, используй team.invite или прямой ответ».
- В этой задаче — без интеграции с meeting-request (#0051).
- Unit:
  - programmer → escalate(product) — participants содержит [programmer, architect, product] (порядок неважен, но все три).
  - product → escalate(programmer) — то же самое (escalate работает в обе стороны).
  - programmer → escalate(architect) — отказ (соседний уровень).
  - programmer → escalate(programmer) — отказ.

## Implementation notes

- Цепочка считается один раз, до первого `pullIntoRoom`. Если посредине что-то падает — допустимо оставить частичное состояние (комната может быть с не всеми участниками); диагностика — в будущем.
- Сообщение пишется один раз, после всех pullIntoRoom — чтобы все приглашённые увидели один и тот же контекст с момента входа.

## Related

- Подзадача #0032.
- Зависит от: #0033, #0036.
- Блокирует: #0039 (промпты ролей).
