---
id: 0051
title: invite/escalate — интеграция с meeting-request при busy + пауза agent-loop
status: done
created: 2026-04-26
---

## Context

`team.invite` (#0037) и `team.escalate` (#0038) сейчас всегда сразу тащат адресата в комнату. Нужно: если адресат (или хотя бы один из промежуточных при escalate) сейчас не `idle` — не тащить, а создать `MeetingRequest` (#0049) и поставить инициатора на паузу.

## Acceptance criteria

- В `team.invite(targetRole, message)`:
  - Перед `pullIntoRoom` проверить `roleStateFor(targetRole)` (#0048).
  - Если не `idle` → создать `MeetingRequest {requesterRole: caller, requesteeRole: targetRole, contextSessionId, message}`, не вызывать pullIntoRoom, вернуть тулу `{kind: 'queued', meetingRequestId}`.
  - Если `idle` → как сейчас.
- В `team.escalate(targetRole, message)`:
  - Если **все** роли в цепочке (кроме caller) idle → как сейчас.
  - Если хотя бы одна не idle → создать единственный `MeetingRequest` к `targetRole` с message; промежуточных подтянет `meeting-resolver` или follow-up задача (на этой итерации — упрощённо: при резолве комнаты в `meeting-resolver` (#0050) дополнительно прогоняем `rolesBetween(requester, requestee)` и pullIntoRoom их тоже, если они idle).
- Когда тул вернул `{kind: 'queued'}` — agent-loop роли `caller` **останавливается**:
  - Никаких новых tool calls.
  - Сессия `caller` отмечается как ждущая ответа на meetingRequest (это derives `awaiting_input` через #0048).
- Когда `meeting-resolver` (#0050) резолвит request → agent-loop инициатора пробуждается с системным сообщением «Получен ответ от <targetRole>, см. сессию <link>».
- Unit:
  - invite к busy → создан request, нет pullIntoRoom, тул вернул queued.
  - escalate с busy product, idle architect → request создан, после резолва в комнате есть architect (как промежуточный).
  - Pause/resume agent-loop через симуляцию резолва.

## Implementation notes

- Pause agent-loop = не запускать следующий шаг scheduler'а для этой роли. Если scheduler сейчас крутится в `while`-цикле — нужна точка проверки `roleState === 'awaiting_input'`.
- Пробуждение — через тот же resolver на завершении сессии-источника (когда новая комната создана и в неё что-то пришло, инициатор продолжает работу).

## Related

- Подзадача #0031.
- Зависит от: #0037, #0038, #0048, #0049, #0050.

## Outcome

- `team.invite`/`team.escalate` (`src/extension/features/team/{invite,escalate}-tool.ts`) проверяют `roleStateFor` адресата (и промежуточных у escalate). Если хотя бы одна роль не `idle` — создают `MeetingRequest` через `appendMeetingRequest` (#0049) и возвращают `{kind: 'queued', meetingRequestId}` без `pullIntoRoom`.
- `agent-loop` (`src/extension/shared/agent-loop/loop.ts`) ловит queued-результат через `extractQueuedMeetingRequestId`, доводит до конца все tool_call-ы шага и выходит с `kind: 'paused'`. Ролевые `finalize*Run` (`product/architect/programmer-role/run.ts`) на `paused` оставляют статус `running` и ждут wake-up.
- `meeting-resolver` (`src/extension/team/meeting-resolver.ts`) при резолве дополнительно подтягивает idle-промежуточные роли цепочки escalate (`pullIntermediateIdleRoles`) и через `notifyMeetingWakeup` (`src/extension/team/meeting-wakeup.ts` + `agent-loop/resume.ts` `meeting_resolved` intent) будит инициатора с системным сообщением о новой комнате.
- Тесты: `src/extension/shared/agent-loop/loop.test.ts` (paused-ветка), новые describe-блоки в `src/extension/team/meeting-resolver.test.ts` (intermediate pull + wakeup-параметры), `invite-tool.test.ts`/`escalate-tool.test.ts` на queued. Коммит реализации b78d028 + done-коммит.
