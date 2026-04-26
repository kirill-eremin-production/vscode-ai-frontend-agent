---
id: 0037
title: Тул team.invite — приглашение соседнего по уровню агента
status: open
created: 2026-04-26
---

## Context

Простой случай добавления участника: соседние уровни иерархии (architect ↔ product, programmer ↔ architect). Через уровень — нельзя, для этого `team.escalate` (#0038).

## Acceptance criteria

- Новый тул, доступный всем агент-ролям: `team.invite(targetRole: Role, message: string)`.
- Поведение:
  - Вычисляет `caller` по контексту вызова (роль текущего агента).
  - Проверяет `areAdjacent(caller, targetRole)` (из #0033). Если false — возвращает ошибку с текстом «Нельзя пригласить через уровень. Используй team.escalate(targetRole, message)».
  - Иначе: вызывает `pullIntoRoom(currentSessionId, targetRole)` (#0036), затем добавляет `message` как сообщение от `caller` в сессию.
  - Возвращает `{sessionId, participants}`.
- В этой задаче — без интеграции с meeting-request (если target busy — всё равно тащим в комнату). Интеграция в #0051.
- Unit:
  - architect → invite(product) — успех, участник добавлен, сообщение записано.
  - programmer → invite(product) — отказ с подсказкой про escalate.
  - architect → invite(architect) — отказ (нельзя пригласить себя; areAdjacent возвращает false для одинаковых).
  - Идемпотентность: повторный invite той же роли — pullIntoRoom no-op, но сообщение записывается (это корректно — это просто новый месседж).

## Implementation notes

- Регистрация тула — там же, где регистрируются остальные `team.*` тулы (создать модуль, если его нет).
- Текст ошибки про escalate важен — это сигнал агенту, что есть правильный путь.

## Related

- Подзадача #0032.
- Зависит от: #0033, #0036.
- Блокирует: #0039 (промпты ролей).
