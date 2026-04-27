# TC-57. meeting-resolver: резолв pending-заявок и deadlock detection — #0050

Инфраструктурный модуль `src/extension/team/meeting-resolver.ts`
автоматически переводит pending meeting-request'ы (#0049) в реальные
сессии-комнаты, как только адресат свободен, и ломает простейший
deadlock «A зовёт B, B зовёт A». Тулы агента, которые создают заявки,
появятся в #0051; полноценный UI inbox — в #0052. Этот TC ручной:
проверяем, что модуль реально подключился (триггеры активации и
завершения сессии работают), а контракт совпадает с unit-тестами.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. В выводе `npm run test:unit` найти сюиты `resolvePending — пустой
случай`, `резолв к idle-роли`, `busy-роль не резолвит`,
   `bidirectional deadlock`, `несколько pending к одной роли`,
   `повторный вызов idempotent для уже резолвнутых` из
   `src/extension/team/meeting-resolver.test.ts` — все зелёные.
3. В тестовом workspace запустить расширение из VS Code (F5), создать
   ран обычным путём (US-2). Когда ран остановится в `awaiting_human`
   (продакт сдал бриф), открыть DevTools (Help → Toggle Developer Tools
   для extension host) и в консоли выполнить:

   ```js
   const storage = await import('./out/extension/entities/run/storage.js');
   const requests = await import('./out/extension/entities/run/meeting-request.js');
   const resolver = await import('./out/extension/team/meeting-resolver.js');
   const runId = '<подставить активный runId из .agents/runs>';
   const meta = await storage.readMeta(runId);
   await requests.createMeetingRequest(runId, {
     requesterRole: 'product',
     requesteeRole: 'architect',
     contextSessionId: meta.activeSessionId,
     message: 'нужен план',
   });
   console.log(await resolver.resolvePending(runId));
   ```

4. Открыть `.agents/runs/<runId>/meeting-requests.jsonl` — последняя
   строка должна быть `{"kind":"status","id":"mr_…","status":"resolved",
"resolvedSessionId":"s_…"}`.
5. В дереве сессий рана появится новая `agent-agent` сессия с парой
   участников `[product, architect]`, `prev = [<runId.activeSessionId
из шага 3>]`. В её `chat.jsonl` — ровно одно сообщение от
   `agent:product` с текстом «нужен план».
6. **Триггер на завершение сессии.** Создать ещё одну заявку (повторить
   `createMeetingRequest`, например, requesterRole=`architect`,
   requesteeRole=`programmer`, message=`x`). НЕ вызывать
   `resolvePending` руками. Через DevTools-консоль перевести любую
   активную сессию в финальный статус, например `awaiting_human`:

   ```js
   await storage.setSessionStatus(runId, meta.activeSessionId, 'awaiting_human');
   ```

   В output-канале «Extension Host» появится след работы резолвера
   (если адресат idle — лог в meeting-requests.jsonl со status=resolved);
   на диске тут же видна новая `agent-agent` сессия и status-строка
   заявки.

7. **Триггер на активации.** Закрыть VS Code, не трогая
   `meeting-requests.jsonl`. Создать руками новую pending-заявку (через
   тот же кусок кода в шаге 3, но на этот раз — пока IDE закрыта,
   через `node`-скрипт или дополнить файл вручную одной валидной
   `created`-строкой). Открыть workspace заново; через несколько секунд
   проверить файл — заявка должна стать `resolved` (если адресат idle)
   или остаться pending (если он busy). Простейший вариант проверки:
   зайти в `.agents/runs/<runId>/sessions/` — должна появиться новая
   директория сессии-комнаты.
8. **Deadlock detection.** Создать одновременно две встречные заявки
   (product↔architect): `requesterRole=product, requesteeRole=architect`
   и `requesterRole=architect, requesteeRole=product`. Дёрнуть
   `resolver.resolvePending(runId)`. Обе заявки в `meeting-requests.jsonl`
   должны получить status-строку `failed` с `failureReason`, содержащим
   `deadlock between product and architect`. В output-канале — `warn`
   с той же фразой.

## Ожидание

- Lint, build, unit-тесты — зелёные.
- Резолв к idle-роли создаёт ровно одну новую сессию-комнату; повторный
  вызов `resolvePending` без новых pending-заявок не создаёт ничего и
  возвращает `[]`.
- pending-заявки к busy-роли остаются `pending` без записи в журнал.
- При нескольких pending к одной роли резолвится самая старая по
  `createdAt`; остальные ждут до следующего триггера (после завершения
  сессии-резолва).
- Bidirectional pending → обе заявки `failed` с одинаковым reason'ом,
  явно упоминающим обе роли и слово `deadlock`.
- Триггер на активации и триггер на смене статуса сессии работают
  без ручного вызова `resolvePending`.
- Сбой резолвера в консоли (например, специально удалить рандомную
  сессию из `sessions/`, чтобы snapshot не собрался) не валит
  активацию и не валит запись статуса в storage — ошибка только в
  output-канале.

## Известные ограничения

- На этой итерации нет тулов, которые порождают заявки сами (это
  #0051) — поэтому шаги 3, 6, 7, 8 руками выполняются через
  DevTools-консоль или ручную правку `meeting-requests.jsonl`.
- UI inbox/baseline для `awaiting_input`-кубика — в #0052; здесь они
  не проверяются.
- На каждом сообщении резолвер не вызывается осознанно (см. AC #0050).
  Если хочется проверить «новое сообщение → резолв», нужно после
  него вызвать `setSessionStatus` или `resolvePending` вручную.
