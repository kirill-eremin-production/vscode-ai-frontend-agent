---
id: 0035
title: Метаданные встречи на сессии — inputFrom, prev[], next[]
status: done
created: 2026-04-26
---

## Context

Чтобы построить хронологический журнал встреч (#0029 → #0046), сессия должна знать кто/что её инициировал и из каких/в какие сессии она переходит. Сейчас есть только `parentSessionId`.

## Acceptance criteria

- Расширить тип `Session`:
  - `inputFrom: Role | 'user'` — кто/что инициировало сессию (роль автора входного артефакта или `'user'`).
  - `prev: SessionId[]` — родительские сессии. Для одного родителя — массив длины 1.
  - `next: SessionId[]` — дочерние сессии. Поддерживается явно при создании дочерней сессии (на write обновляем массив у родителя).
- На чтении старых сессий: read-time normalization
  - `prev = parentSessionId ? [parentSessionId] : []`
  - `next` — собрать обратным индексом по всем сессиям рана (один раз при загрузке списка сессий рана).
  - `inputFrom` — для bridge/agent-сессии = роль `participants[0]` родительской (если выводимо), иначе `'user'` для корневой. Если вывести нельзя — `'user'` как безопасный фолбэк.
- При создании новой дочерней сессии: проставлять `prev` явно, обновлять `next` у родителя (write+persist).
- Unit: создание цепочки user→product→architect, проверка `prev`/`next` у всех трёх.
- Unit: ветвление — одна сессия порождает две дочерних, у родителя `next.length === 2`.
- Unit: read-time normalization на фикстуре старого формата.

## Implementation notes

- Не вводить отдельную сущность `Meeting` — это поля сессии.
- `parentSessionId` оставить пока как алиас для обратной совместимости в сериализации (можно вычислять из `prev[0]` при write для миграции). Удаление — отдельная задача в будущем.
- `participants` (#0034) — отдельное поле, не пересекается с `inputFrom`. `inputFrom` — это **источник входа**, не участник.

## Related

- Подзадача #0029.
- Зависит от: #0034.
- Блокирует: #0046 (UI журнала встреч).

## Outcome

- `SessionMeta`/`SessionSummary` расширены полями `inputFrom`, `prev[]`, `next[]`; `parentSessionId` оставлен как алиас на `prev[0]` для обратной совместимости (см. [src/extension/entities/run/types.ts](src/extension/entities/run/types.ts), [src/webview/shared/runs/types.ts](src/webview/shared/runs/types.ts)).
- `createSession` принимает `prev` явно и одним write+persist обновляет `next` родителя (и в его session-meta, и в run-meta); read-time нормализация в `readMeta` пересчитывает `next` обратным индексом и уточняет `inputFrom` по `participants[0]` родителя — legacy-раны мигрируют без правки диска (см. [src/extension/entities/run/storage.ts](src/extension/entities/run/storage.ts)).
- Реализация прошла ревью без замечаний: AC покрыты unit-тестами (линейная цепочка, ветвление, legacy-нормализация — [src/extension/entities/run/storage.test.ts](src/extension/entities/run/storage.test.ts)), US-35 и TC-42 синхронно обновлены, `lint`/`build`/`test:unit` зелёные. Коммит реализации — `faf1908`.
