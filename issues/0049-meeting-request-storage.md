---
id: 0049
title: MeetingRequest — сущность и storage
status: open
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
