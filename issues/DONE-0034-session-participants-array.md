---
id: 0034
title: Session.participants — массив Role[] вместо пары
status: done
created: 2026-04-26
---

## Context

Все agent↔agent сессии сейчас строго парные. Дальнейшие задачи (#0036 pullIntoRoom, #0038 escalate) требуют N>2 участников. Эта задача — чисто типовая миграция, без новой функциональности.

## Acceptance criteria

- Поле `Session.participants: Role[]` (длина ≥ 1).
- На чтении старых session-файлов: read-time normalization из старых полей (`agentRole`/тип сессии) в массив длины 2. Файлы на диске не переписываем.
- Все места, делающие `participants[0]`/`participants[1]`/`.length === 2` или деструктурирующие пару, ревизованы и переписаны на работу с массивом произвольной длины. Грубый поиск: `rg "participants\[" src/`, `rg "participants.length" src/`.
- Новые сессии при write пишут массив в новом формате сразу.
- Unit: read-time normalization на фикстуре старого формата.
- Unit: создание и сериализация новой сессии с `participants` длины 2 и 3.
- Существующие тесты проходят.

## Implementation notes

- Эта задача намеренно **не** добавляет API для добавления участника (это #0036). Здесь только тип + чтение/запись.
- Не менять `authorRole` в сообщениях — он и так per-message и не зависит от формата `participants`.
- Если где-то была проверка типа сессии `'agent-agent'` через длину — заменить на явное поле типа сессии (если его нет — оставить производным).

## Related

- Подзадача #0030.
- Блокирует: #0036, #0041.

## Outcome

- `SessionMeta.participants: Participant[]` всегда длины ≥ 1; legacy
  meta.json без массива (или с `agentRole`/только `kind`) нормализуется
  на чтении через `normalizeParticipants` в
  [src/extension/entities/run/storage.ts](../src/extension/entities/run/storage.ts) —
  файл на диске не переписываем.
- Round-trip новых сессий длины 2 и 3 покрыт unit-тестами в
  [src/extension/entities/run/storage.test.ts](../src/extension/entities/run/storage.test.ts)
  (сюита `participants — массив произвольной длины (#0034)`).
- Ревизия `rg "participants\[|participants\.length === 2" src/` — пусто.
  US-34 (инфра) + TC-41 (ручной) фиксируют контракт. Реализация прошла
  ревью без замечаний (коммит `94347a4`).
