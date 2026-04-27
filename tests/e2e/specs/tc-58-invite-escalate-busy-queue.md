# TC-58. invite/escalate ставят встречу в очередь, когда адресат занят — #0051

`team.invite` и `team.escalate` теперь интегрированы с
`meeting-request` (#0049) и координатором (#0050): если адресат
(или хотя бы одна роль в цепочке escalate) не `idle`, тул не делает
`pullIntoRoom`, а кладёт заявку и возвращает `{kind:'queued'}`.
Agent-loop инициатора в ответ останавливается на `paused`. После того
как координатор резолвит заявку, инициатор пробуждается через
`resumeRun` с интентом `meeting_resolved`. UI inbox-а ещё нет (это
#0052), поэтому проверка частично ручная через DevTools-консоль.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. В выводе `npm run test:unit` найти сюиты:
   - `team.invite — happy path`, `team.invite — #0051: занятый адресат
→ queued meeting-request`, `team.invite — #0051: повторный invite
на занятого адресата` из
     `src/extension/features/team/invite-tool.test.ts`;
   - `team.escalate — happy path: programmer → product`,
     `team.escalate — happy path: product → programmer (обратное
направление)`, `team.escalate — #0051: занятый посредник в цепочке
→ queued` из `src/extension/features/team/escalate-tool.test.ts`;
   - `loop возвращает paused при queued tool-result`,
     `resume по интенту meeting_resolved пишет marker с id заявки и
  resolvedSessionId` из `src/extension/shared/agent-loop/*.test.ts`.
     Все — зелёные.
3. В тестовом workspace запустить расширение из VS Code (F5), создать
   ран обычным путём (US-2). Дождаться остановки в `awaiting_human` (после
   брифа продакта). Открыть DevTools (Help → Toggle Developer Tools для
   extension host).
4. **Симуляция «адресат занят».** В DevTools-консоли:

   ```js
   const storage = await import('./out/extension/entities/run/storage.js');
   const requests = await import('./out/extension/entities/run/meeting-request.js');
   const resolver = await import('./out/extension/team/meeting-resolver.js');
   const runId = '<runId из .agents/runs>';
   const meta = await storage.readMeta(runId);
   // создаём bridge-сессию product↔architect и оставляем последнее
   // слово за продактом — архитектор будет busy
   const bridge = await storage.createSession(runId, {
     kind: 'agent-agent',
     participants: [
       { kind: 'agent', role: 'product' },
       { kind: 'agent', role: 'architect' },
     ],
     prev: [meta.activeSessionId],
     status: 'running',
   });
   await storage.appendChatMessage(
     runId,
     {
       id: 'm-bridge',
       from: 'agent:product',
       at: new Date().toISOString(),
       text: 'архитектор, проверь',
     },
     bridge.session.id
   );
   // возвращаем активную сессию инициатору-программисту
   await storage.setActiveSession(runId, meta.activeSessionId);
   // имитируем вызов программистом team.escalate(product) при busy architect
   await requests.createMeetingRequest(runId, {
     requesterRole: 'programmer',
     requesteeRole: 'product',
     contextSessionId: meta.activeSessionId,
     message: 'нужно срочное уточнение',
   });
   ```

5. Открыть `.agents/runs/<runId>/meeting-requests.jsonl` — последняя
   строка должна быть `{"kind":"created","request":{...,"requesterRole":
"programmer","requesteeRole":"product",...,"status":"pending"}}`.
6. **Ручной триггер резолвера.** В DevTools-консоли:

   ```js
   console.log(await resolver.resolvePending(runId));
   ```

   Шаги внутри:
   - Заявка к продакту (idle, после восстановления activeSessionId)
     резолвится: появляется новая `agent-agent` сессия с участниками
     `[programmer, product]`, в неё дополнительно подтягивается
     `architect` (промежуточный из `rolesBetween`), если он idle к
     моменту резолва. Если архитектор busy — пытаемся pullIntoRoom,
     если занят, пропускаем и резолвим только requester+requestee.
   - `meeting-requests.jsonl` получает `status`-строку с
     `"status":"resolved"` и `resolvedSessionId`.
   - Output-канал «Extension Host» пишет след `meeting wakeup` для
     инициатора (см. `setMeetingWakeupHandler` в `index.ts`); если
     ран не активен (нет registry resumer'а) — это безопасный no-op.

7. **Симуляция paused в agent-loop.** Прямой проверки UI пока нет,
   опираемся на unit-тесты `loop.test.ts > paused` и на content
   `tools.jsonl` рана: при queued там должна быть запись `system`-event
   с упоминанием meeting-request id (см. `loop.ts`). В реальном проде
   это станет видно после интеграции с UI inbox (#0052).
8. **Resume через `meeting_resolved`.** В DevTools-консоли:

   ```js
   const resume = await import('./out/extension/entities/run/resume-registry.js');
   await resume.resumeRun({
     runId,
     intent: {
       kind: 'meeting_resolved',
       meetingRequestId: '<id заявки из шага 5>',
       targetRole: 'product',
       resolvedSessionId: '<id сессии-комнаты из шага 6>',
     },
   });
   ```

   В `tools.jsonl` инициатора должен появиться маркер `Resume after
meeting-request <id> resolved (reply from product, session <sid>)`.

9. **Pull intermediate через резолвер.** Создать ещё один сценарий —
   занят архитектор, программист эскалирует к продакту. После резолва
   проверить, что `architect` подтянулся в новую комнату как
   промежуточный (если на момент резолва он стал idle). Это
   единственный путь, по которому промежуточные роли попадают в
   комнату при escalate-через-busy.

## Ожидание

- Lint, build, unit-тесты — зелёные.
- Создание meeting-request не модифицирует `chat.jsonl` инициатора и
  не меняет состав его активной сессии (никаких pullIntoRoom).
- Файл `meeting-requests.jsonl` хранит ровно одну `created`-строку на
  один queued-вызов и одну `status`-строку на резолв.
- После резолва — новая `agent-agent` сессия `[requester, requestee]`,
  опционально дополненная idle-промежуточными; в её `chat.jsonl` —
  ровно одно сообщение от requester'а с текстом из заявки.
- Resume-marker для `meeting_resolved` буквальный, содержит id заявки,
  роль адресата и id сессии-резолва (см. `buildResumeMarker`).
- Loop инициатора при queued-tool-result возвращает `{kind:'paused'}`
  и не пишет финальный response — финализатор роли early-return'ит,
  статус остаётся `running`.
- Дополнительные tool-result'ы paused-итерации не появляются (loop
  останавливает цикл сразу, см. `loop.ts`).

## Известные ограничения

- UI inbox/уведомление об ожидании meeting-request — задача #0052;
  здесь не проверяется.
- Полностью автоматический e2e (через VS Code Test Runner) пока не
  настроен — этот TC ручной поверх unit-тестов и DevTools.
- Резолвер сам не пробуждает инициатора, если расширение перезапущено
  ровно в момент резолва: на активации триггер `resolvePending` пройдёт
  ещё раз и пробуждение случится из обычной ветки `setMeetingWakeupHandler`.
