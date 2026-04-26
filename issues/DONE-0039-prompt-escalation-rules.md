---
id: 0039
title: Промпты ролей — правило escalate vs invite
status: done
created: 2026-04-26
---

## Context

Тулы `team.invite` (#0037) и `team.escalate` (#0038) реализованы; теперь нужно объяснить агентам, когда какой использовать. Soft-rule в промпте + runtime-проверка в тулах = правильный сигнал.

## Acceptance criteria

- В системных промптах ролей (`src/extension/entities/run/roles/*.prompt.ts`) добавлен раздел «Команда и эскалация»:
  - Краткое описание иерархии (User → Product → Architect → Programmer).
  - Правило: для соседнего уровня — `team.invite(role, message)`. Через уровень — `team.escalate(role, message)`, тул сам подтянет промежуточных.
  - Пример: programmer задаёт вопрос product → `team.escalate('product', '…')` → в комнате окажутся programmer + architect + product.
- Для роли programmer: явный пример с вопросом продакту через эскалацию.
- Для роли architect: правило, что invite соседних (product/programmer) — норма; escalate почти не нужен.
- Для роли product: правило, что escalate(programmer) автоматически подтянет архитектора.
- Никаких изменений в коде вне промпт-файлов.
- Если в репо есть snapshot/golden-тесты на промпты — обновить их.

## Implementation notes

- Промпты на русском (как остальные в проекте).
- Не дублировать описание иерархии — вынести в общий префикс, если такой механизм уже есть, иначе короткий повтор в каждом промпте допустим.

## Related

- Подзадача #0032.
- Зависит от: #0037, #0038.

## Outcome

В трёх ролевых промптах (`src/extension/entities/run/roles/{product,architect,programmer}.prompt.ts`)
добавлен раздел `## Команда и эскалация` с иерархией `User → product → architect → programmer`,
правилом «соседний уровень → `team.invite`, через уровень → `team.escalate`» и ролевой
конкретикой по AC: programmer получил пример эскалации к продакту с итоговым составом
`[programmer, architect, product]`, architect — указание, что invite соседей норма и
escalate ему практически не нужен, product — подсказку, что `team.escalate('programmer', ...)`
сам подтянет архитектора. Покрытие — `team-escalation-prompts.test.ts` (snapshot-стайл
подстроки для каждого инварианта), US-39 в `tests/user-stories.md`, ручной TC-46.
Реализация — коммит 120b544.
