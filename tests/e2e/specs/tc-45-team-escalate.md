# TC-45. team.escalate — эскалация через уровни иерархии (#0038)

Тул `team.escalate(targetRole, message)` доступен всем агент-ролям и
композитит несколько `pullIntoRoom` (#0036) с записью одного
сообщения от имени caller'а после того, как все посредники добавлены
в комнату. Соседний уровень и self-target — отказ с подсказкой про
`team.invite`.

Запуск тула выполняется моделью внутри agent-loop'а, поэтому
полностью автоматизировать через E2E на реальных моделях мы не
можем (см. правило «smoke на реальных моделях не делаем» в AGENT.md).
TC ручной и проверяет инвариант через файлы на диске + unit-тесты.

## Подготовка

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
   В выводе unit-тестов присутствуют сюиты:
   - `team.escalate — happy path: programmer → product` —
     `добавляет архитектора и продакта, пишет одно сообщение от программиста, возвращает цепочку`.
   - `team.escalate — happy path: product → programmer (обратное направление)` —
     `escalate работает в обе стороны: продакт зовёт программиста через архитектора`.
   - `team.escalate — отказ для соседних уровней` —
     `programmer → escalate(architect): соседний уровень → ошибка с подсказкой про invite`.
   - `team.escalate — отказ при caller === targetRole` —
     `programmer → escalate(programmer): сам себе эскалировать бессмысленно`.

## Шаги

1. Открыть `src/extension/features/team/escalate-tool.ts`. Найти
   `buildTeamEscalateTool(caller)`. Проверить:
   - schema: `targetRole` — enum `['product', 'architect', 'programmer']`,
     `message` — `string` с `minLength: 1`, `additionalProperties: false`;
   - текст ошибки `ESCALATE_NOT_NEEDED_ERROR` буквально:
     «escalate не нужен, используй team.invite или прямой ответ»;
   - цепочка собирается через `rolesBetween` (#0033) и оборачивается
     в `[caller, ...between, target]`;
   - сообщение пишется ровно один раз ПОСЛЕ цикла `pullIntoRoom` —
     это инвариант «у всех приглашённых одинаковый стартовый контекст».
2. В `src/extension/features/product-role/run.ts`,
   `architect-role/run.ts`, `programmer-role/run.ts` найти регистрацию
   `buildTeamEscalateTool(<ROLE>)` в `buildXxxRegistry()` — caller для
   каждой роли соответствует имени модуля. Также проверить, что
   `team.escalate` присутствует в `xxxToolNames()` рядом с `team.invite`.

## Ожидание

- Lint и build зелёные — типы synced (`Role` для `targetRole`).
- Все 4 unit-сюиты `team.escalate` зелёные.
- В `tests/user-stories.md` есть запись US-38 с акцентом на цепочку
  через посредников, инвариант «один message после всех pullIntoRoom»
  и отказ для соседей/self-target.

## Известные ограничения

- Полноценный E2E «программист эскалирует продакта по тулу, webview
  видит обновлённый состав» не делается: webview-рендера
  `participant_joined` пока нет (#0046), а тул вызывается моделью —
  верификация через настоящего OpenRouter'а противоречит правилу
  «не тестируем сами модели» (AGENT.md). После #0046 + #0051 (busy
  integration) появится отдельный TC, где escalate запускается через
  сценарий fake-OpenRouter и проверяется и через UI, и через файлы.
- Допустимо частичное состояние при сбое посредине цепочки (см. US-38
  и Implementation notes #0038): в этом TC такие сценарии не
  моделируются — диагностика и компенсация будут отдельной задачей.
