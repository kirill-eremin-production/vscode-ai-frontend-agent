# TC-59. Paused-визуал: кубик / карточка / inbox — #0052

UI-завершение системы meeting-request: на канвасе появляется
paused-кубик с клок-иконкой, карточка соответствующей сессии в
журнале встреч получает статус «ждёт ответа от <роль>», а в
секции «Заявки на встречи» (внутри панели «Встречи») перечисляются
все pending-заявки рана. Live-обновления приходят через broadcast
`runs.pendingRequests.updated`. До #0052 этих UI-сигналов не было —
агент-loop ставил заявку и молчал, пользователь не понимал, почему
ран встал. Полностью автоматический e2e пока не настроен — TC
комбинирует unit-тесты и ручную симуляцию через DevTools.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. В выводе `npm run test:unit` найти сюиты:
   - `cubeStateFor — paused, если у роли есть pending meeting-request
как у requester`,
   - `cubeStateFor — paused имеет приоритет над awaiting_user`,
   - `pausedRequesteeFor возвращает самую свежую заявку, если их
несколько`,
   - `pausedRequesteeFor возвращает undefined, если у роли нет pending
как requester`
     из `src/webview/features/canvas/cube-state.test.ts`. Все — зелёные.
3. В тестовом workspace запустить расширение из VS Code (F5), создать
   ран обычным путём (US-2). Дождаться остановки в `awaiting_human`
   (после брифа продакта). Открыть DevTools (Help → Toggle Developer
   Tools для extension host).
4. **Симуляция «адресат занят» + создание заявки.** В DevTools-консоли:

   ```js
   const storage = await import('./out/extension/entities/run/storage.js');
   const requests = await import('./out/extension/entities/run/meeting-request.js');
   const broadcast = await import('./out/extension/features/run-management/pending-requests.js');
   const runId = '<runId из .agents/runs>';
   const meta = await storage.readMeta(runId);
   await requests.createMeetingRequest(runId, {
     requesterRole: 'architect',
     requesteeRole: 'programmer',
     contextSessionId: meta.activeSessionId,
     message: 'проверь оценку, успеваем ли мы в этот спринт',
   });
   await broadcast.broadcastPendingRequests(runId);
   ```

5. **Inbox.** В правой side-area выбрать таб «Встречи». Сверху должна
   появиться секция `data-pending-requests-inbox` с заголовком
   «Заявки на встречи (1)» и одной строкой:
   `architect → programmer: проверь оценку, успеваем ли мы…`. Клик по
   строке делает drill-in в `contextSessionId` (то есть переключает
   таб на «Чат» и выбирает корневую сессию). DOM-маркеры:
   `[data-pending-request][data-pending-request-id="<id>"]`,
   `[data-pending-request-context="<sessionId>"]`.
6. **Карточка сессии в журнале.** Под inbox'ом — список встреч.
   У карточки сессии-инициатора (id совпадает с `contextSessionId`
   заявки) должно быть `data-meeting-status="paused"`, точка статуса —
   жёлтая, подпись — «ждёт ответа от программиста» вместо обычной
   «активна»/«завершена».
7. **Кубик на канвасе.** Переключиться на таб «Карта». У кубика
   `architect` атрибут `data-canvas-cube-state="paused"`, в правом-
   верхнем углу — клок-иконка `data-canvas-cube-pause-icon`, кубик
   нарисован с пониженной opacity. Подпись под кубиком: «ждёт ответа
   от программиста». Спиннера working быть не должно.
8. **Резолв и live-исчезновение.** В DevTools-консоли:

   ```js
   const resolver = await import('./out/extension/team/meeting-resolver.js');
   console.log(await resolver.resolvePending(runId));
   ```

   После резолва (программист idle, заявка ушла в `resolved`) UI
   обновится сам — broadcast `runs.pendingRequests.updated` придёт
   с пустым `pendingRequests`:
   - элемент инбокса исчезает; вся секция инбокса свёрнута, потому
     что pending'ов больше нет;
   - карточка соответствующей сессии возвращается в обычный
     статус (`data-meeting-status="active"`/`finished`);
   - кубик `architect` уходит из `paused`, обычно в `idle` (после
     резолва архитектор не участник новой комнаты сразу).

9. **Дедлок-fail.** Создать пару взаимных заявок:

   ```js
   await requests.createMeetingRequest(runId, {
     requesterRole: 'architect',
     requesteeRole: 'programmer',
     contextSessionId: meta.activeSessionId,
     message: 'обсудим X',
   });
   await requests.createMeetingRequest(runId, {
     requesterRole: 'programmer',
     requesteeRole: 'architect',
     contextSessionId: meta.activeSessionId,
     message: 'обсудим Y',
   });
   await broadcast.broadcastPendingRequests(runId);
   await resolver.resolvePending(runId);
   ```

   Обе заявки должны уйти в `failed` (deadlock), inbox обнулиться,
   `data-meeting-status` карточки вернуться в обычное значение.

## Ожидание

- Lint, build, unit-тесты — зелёные; в `cube-state.test.ts` есть
  4 новых проходящих теста для paused-веток.
- Inbox показывает только pending-заявки рана; resolved/failed туда
  не попадают (extension шлёт snapshot pending'ов целиком).
- Live-обновления идут через `runs.pendingRequests.updated`. Частоты
  тиков нет — broadcast'ы дёргаются только в горячих точках
  (создание заявки в `team.invite`/`team.escalate` queued-ветке;
  резолв/deadlock-fail в `meeting-resolver`).
- Paused-визуал кубика отличим от idle (клок-иконка + opacity) и от
  working (нет спиннера).
- Карточка paused визуально отличима от finished (жёлтая точка vs
  серая) и от active (жёлтая vs зелёная).
- Drill-in из inbox идёт в `contextSessionId` — ту сессию, где
  инициатор поставил встречу.

## Известные ограничения

- TC ручной поверх unit-тестов; полноценный Playwright-e2e (запуск
  VS Code, создание заявки, проверка DOM webview через
  `_electron.launch()`) пока не настроен.
- Inbox без действий (отмена/принудительный резолв) — это будущее
  (см. Implementation notes #0052).
- Управление per-request приоритетом из UI отсутствует; порядок
  определяется `createdAt` в координаторе.
