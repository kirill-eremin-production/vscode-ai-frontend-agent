# TC-43. pullIntoRoom — добавление роли в сессию-комнату (#0036)

Задача инфраструктурная: добавлен action `pullIntoRoom(sessionId, role)` и
системное событие `participant_joined`. UI-рендер события пока не делается
(появится в #0046 «Журнал встреч»), а вызывающего кода (тулы
`team.invite`/`team.escalate`) ещё нет — поэтому TC ручной и проверяет
поведение через файлы на диске + unit-тесты.

## Подготовка

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
   В выводе unit-тестов присутствует сюита `pullIntoRoom (#0036)`, все её
   кейсы зелёные:
   - `добавляет новую роль: participants обновился, событие записано`
   - `повторный вызов с той же ролью — no-op, событие не дублируется`
   - `запись в журнал сессии корректна и читается обратно`

## Шаги

Поскольку action ещё не привязан к публичному UI/IPC и не вызывается
из тулов, TC сводится к verification по результатам unit-сюиты + lint/build.
Когда появится тул `team.invite` (#0037), сценарий E2E будет добавлен
отдельно.

1. Открыть исходник `src/extension/entities/run/storage.ts`.
2. Найти экспорт `pullIntoRoom` — функция должна присутствовать с сигнатурой
   `(runId: string, sessionId: string, role: string): Promise<RunMeta | undefined>`.
3. Найти в дискриминированном union'е `ToolEvent` вариант `kind: 'participant_joined'`
   с полями `at: string` и `role: string`.
4. Открыть `src/webview/shared/runs/types.ts` — webview-зеркало `ToolEvent`
   тоже содержит вариант `participant_joined` (синхронность контракта между
   extension и webview).

## Ожидание

- Lint и build зелёные — TS-границы webview/extension не нарушены, новый
  вариант ToolEvent корректно учтён в `buildTimeline` (`RunDetails.tsx`).
- Unit-сюита `pullIntoRoom (#0036)` зелёная.
- В `tests/user-stories.md` есть запись US-36 с описанием инфраструктурного
  контракта.

## Известные ограничения

- E2E-проверки реального кейса «архитектор втащен в чат продакта» нет: тула
  `team.invite` ещё не существует. После #0037 добавится отдельный TC, где
  pullIntoRoom вызывается через model-tool и проверяется и через UI, и через
  файлы.
- UI журнала встреч (#0046) этой задачей не делается — событие
  `participant_joined` лежит в `tools.jsonl`, в ленте чата (`RunDetails`)
  оно намеренно скрыто, чтобы не шуметь до появления отдельного стиля
  рендера.
