---
id: 0049
title: MeetingRequest — сущность и storage
status: done
created: 2026-04-26
---

## Context

Запрос на встречу (#0031) — отдельная сущность в run-каталоге, переживающая рестарт VS Code.

## Acceptance criteria

- Тип `MeetingRequest`:
  ```ts
  {
    id: string;
    requesterRole: Role;
    requesteeRole: Role;
    contextSessionId: SessionId; // сессия инициатора, из которой возник запрос
    message: string;             // первое сообщение, которое уйдёт в созданную комнату
    createdAt: ISOTimestamp;
    status: 'pending' | 'resolved' | 'failed';
    resolvedAt?: ISOTimestamp;
    resolvedSessionId?: SessionId; // куда резолвнулось
    failureReason?: string;
  }
  ```
- Storage: append-only `meeting-requests.jsonl` в каталоге рана. Каждая строка — JSON либо «новый request», либо «status update» по id (последний выигрывает при load).
- API:
  - `createMeetingRequest(req): MeetingRequest` — присваивает id, пишет.
  - `updateMeetingRequestStatus(id, status, extra)` — append.
  - `listMeetingRequests(runId): MeetingRequest[]` — load + fold.
  - `getPendingRequests(runId): MeetingRequest[]`.
- Unit:
  - Создание и чтение.
  - Update статуса — последняя запись побеждает.
  - Восстановление списка после симуляции рестарта (повторная загрузка с диска).
- В этой задаче — только storage. Логика «когда создавать», «когда резолвить» — в #0050/#0051.

## Implementation notes

- Имена файлов и расположение — соответствуют текущим конвенциям run-каталога (см. остальные jsonl-файлы рана).
- Не делать индекс по ролям в файле — folding в памяти достаточно (число запросов мало).

## Related

- Подзадача #0031.
- Блокирует: #0050, #0051.

## Outcome

- Реализовано append-only хранилище заявок на встречу:
  [`src/extension/entities/run/meeting-request.ts`](../src/extension/entities/run/meeting-request.ts)
  с API `createMeetingRequest`/`updateMeetingRequestStatus`/`listMeetingRequests`/`getPendingRequests`.
  Артефакт лежит в `.agents/runs/<runId>/meeting-requests.jsonl`; folding
  «последняя запись по id побеждает» — на чтении.
- Покрытие: 11 unit-тестов в
  [`meeting-request.test.ts`](../src/extension/entities/run/meeting-request.test.ts)
  (создание/чтение, last-wins, восстановление после рестарта,
  осиротевшие апдейты, getPendingRequests, битые строки), US-48 и
  ручной [TC-56](../tests/e2e/specs/tc-56-meeting-request-storage.md).
- Из `storage.ts` экспортирован `getRunDir`, чтобы соседние модули
  складывали свои jsonl-артефакты в ту же папку рана без дублирования
  констант.
- Логика «когда создавать/резолвить» сюда не входит — это #0050/#0051.
- Коммиты: 6da8c03 (impl).
