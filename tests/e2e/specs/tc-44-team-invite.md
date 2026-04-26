# TC-44. team.invite — приглашение соседа по иерархии (#0037)

Тул `team.invite(targetRole, message)` доступен всем агент-ролям и
композитит `pullIntoRoom` (#0036) с записью сообщения от имени caller'а.
Через уровень — отказ с подсказкой про `team.escalate` (#0038).

Запуск тула выполняется моделью внутри agent-loop'а, поэтому полностью
автоматизировать через E2E на реальных моделях мы не можем (см.
правило «smoke на реальных моделях не делаем» в AGENT.md). TC ручной и
проверяет инвариант через файлы на диске + unit-тесты.

## Подготовка

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
   В выводе unit-тестов присутствуют сюиты:
   - `team.invite — happy path: architect зовёт product` —
     `добавляет участника, пишет сообщение архитектора и возвращает обновлённый состав`.
   - `team.invite — запрет приглашать через уровень` —
     `programmer → invite(product) бросает ошибку с подсказкой про team.escalate`.
   - `team.invite — нельзя пригласить самого себя` —
     `architect → invite(architect): areAdjacent(a, a) === false → ошибка`.
   - `team.invite — идемпотентность повторного invite` —
     `второй invite той же роли: участник не дублируется, событие — нет, сообщение — да`.

## Шаги

1. Открыть `src/extension/features/team/invite-tool.ts`. Найти
   `buildTeamInviteTool(caller)`. Проверить:
   - schema: `targetRole` — enum `['product', 'architect', 'programmer']`,
     `message` — `string` с `minLength: 1`, `additionalProperties: false`;
   - текст ошибки `INVITE_THROUGH_LEVEL_ERROR` буквально содержит
     «Нельзя пригласить через уровень. Используй team.escalate(targetRole, message)».
2. В `src/extension/features/product-role/run.ts`, `architect-role/run.ts`,
   `programmer-role/run.ts` найти регистрацию `buildTeamInviteTool(<ROLE>)`
   в `buildXxxRegistry()` — caller для каждой роли соответствует имени
   модуля. Также проверить, что `team.invite` присутствует в
   `xxxToolNames()`.

## Ожидание

- Lint и build зелёные — типы synced (`Role` для `targetRole`).
- Все 4 unit-сюиты `team.invite` зелёные.
- В `tests/user-stories.md` есть запись US-37, описывающая контракт
  тула с акцентом на отказ через уровень и идемпотентность.

## Известные ограничения

- Полноценный E2E-сценарий «архитектор приглашает продакта по тулу,
  webview видит обновлённый состав» не делается: webview-рендера
  `participant_joined` пока нет (#0046), а тул вызывается моделью —
  верификация через настоящего OpenRouter'а противоречит правилу
  «не тестируем сами модели» (AGENT.md). После #0046 + #0051 (busy
  integration) появится отдельный TC, где invite запускается
  через сценарий fake-OpenRouter и проверяется и через UI, и через
  файлы.
- Текст системного сообщения о приглашении в чате намеренно остаётся
  на стороне caller'а (модель пишет как обычное assistant-сообщение):
  отдельной системной плашки «X пригласил Y» в этой задаче нет.
