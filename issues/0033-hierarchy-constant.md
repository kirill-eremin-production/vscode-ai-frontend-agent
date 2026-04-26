---
id: 0033
title: Общая hierarchy-константа ролей в src/extension/team/hierarchy.ts
status: open
created: 2026-04-26
---

## Context

И canvas-иерархия (#0028 → #0042), и правила escalation (#0032 → #0038) опираются на одну и ту же иерархию ролей. Чтобы избежать дублирования, выносим её в общий модуль раз и навсегда.

## Acceptance criteria

- Новый файл `src/extension/team/hierarchy.ts` экспортирует:
  - `HIERARCHY: readonly Role[]` — упорядоченный массив `['product', 'architect', 'programmer']` (User вне массива — он не агент).
  - `levelOf(role: Role): number` — индекс роли в массиве.
  - `rolesBetween(a: Role, b: Role): Role[]` — упорядоченная цепочка промежуточных ролей строго между a и b (не включая концы), пустой массив для соседних.
  - `areAdjacent(a: Role, b: Role): boolean`.
- `Role` — существующий тип. Если он сейчас не включает `'user'`, не трогать; если включает — `levelOf('user')` бросает.
- Unit-тесты на `rolesBetween` для всех пар + `areAdjacent`.
- Никакие другие модули в этой задаче не меняются (только создание + тесты).

## Implementation notes

- Не делать ничего «на вырост» — никаких ветвлений, мульти-менеджеров, конфигов. Линейный массив.
- Импорт `Role` — из существующего места определения типа (см. `src/extension/entities/run` или подобное).

## Related

- Подзадача #0028 и #0032.
- Используется в #0042 (canvas-layout) и #0038 (team.escalate).
