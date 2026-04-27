# TC-56. MeetingRequest storage: append-only журнал и folding — #0049

Задача чисто инфраструктурная: модуль
`src/extension/entities/run/meeting-request.ts` — append-only хранилище
заявок на встречи. Прямого UI-эффекта на этой итерации нет (inbox и
карточки meetings/awaiting появятся в #0052). Этот TC ручной и сводится
к тому, чтобы удостовериться: модуль реально подключился к кодовой базе,
файл-журнал создаётся в правильной папке, формат строк соответствует
контракту.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. Убедиться, что в выводе `npm run test:unit` присутствуют сюиты
   `createMeetingRequest`, `listMeetingRequests`,
   `updateMeetingRequestStatus`, `восстановление после рестарта` и
   `getPendingRequests` из
   `src/extension/entities/run/meeting-request.test.ts`.
3. В тестовом workspace запустить расширение из VS Code (F5), создать
   ран обычным путём (US-2). Открыть DevTools (Help → Toggle Developer
   Tools для extension host) и в консоли выполнить:
   ```js
   const { createMeetingRequest, listMeetingRequests, updateMeetingRequestStatus } =
     await import('./out/extension/entities/run/meeting-request.js');
   const runId = '<подставить активный runId из .agents/runs>';
   const request = await createMeetingRequest(runId, {
     requesterRole: 'product',
     requesteeRole: 'architect',
     contextSessionId: 's_test',
     message: 'тест-запрос',
   });
   await updateMeetingRequestStatus(runId, request.id, 'resolved', { resolvedSessionId: 's_room' });
   console.log(await listMeetingRequests(runId));
   ```
   _(Альтернатива: написать фрагмент в командах разработчика; сам кейс
   скрипт-агностичен — главное вызвать API.)_
4. Открыть в проводнике файл
   `.agents/runs/<runId>/meeting-requests.jsonl`. Убедиться, что в нём
   ровно две строки: `{"kind":"created", ...}` и `{"kind":"status", ...}`.
5. Закрыть VS Code, открыть заново тот же workspace. Снова выполнить
   `listMeetingRequests(runId)` (как в шаге 3, без create/update) и
   проверить, что заявка возвращается со `status: 'resolved'` и
   `resolvedSessionId: 's_room'` — состояние пережило рестарт.

## Ожидание

- Lint, build, unit-тесты — зелёные.
- Файл `meeting-requests.jsonl` появляется только после первого вызова
  `createMeetingRequest`; до этого момента его нет (валидное состояние
  свежего рана).
- Каждый вызов API добавляет одну строку — никаких перезаписей всего
  файла.
- После рестарта VS Code значение `listMeetingRequests` идентично тому,
  что было в памяти до закрытия редактора (свёртка на чтении).
- Если в ходе экспериментов руками дописать в файл битую строку (например,
  `{ что-то}` без кавычек), `listMeetingRequests` всё равно возвращает
  валидные заявки — битая строка пропущена.

## Известные ограничения

- На этой итерации модуль никем не вызывается из рантайма (продакшн-код
  потребителей появится в #0050/#0051) — поэтому шаг 3 руками выполняется
  через DevTools-консоль. После #0050 этот TC устареет; обновить его
  синхронно (заменить ручные вызовы на сценарий через тулы агента).
- UI-выходы заявок (inbox, paused-кубик, секция meetings) — в #0052;
  здесь они не проверяются.
