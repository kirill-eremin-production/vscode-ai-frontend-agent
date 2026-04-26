import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectKnowledgeFile,
  expectRunStatus,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TC-19. Продакт: sandbox kb работает на уровне обёртки тулов — US-9.
 *
 * Главный инвариант: модель пишет относительные пути (`decisions/...`),
 * под капотом всё префиксуется ролью → файлы оказываются ТОЛЬКО под
 * `.agents/knowledge/product/`. В `tools.jsonl` аргументы tool_call
 * сохраняются как пришли от модели (без префикса) — это и есть граница
 * между «что видит модель» и «что попадает в sandbox».
 *
 * Сценарий ответов модели:
 *  - response[0] — заголовок.
 *  - response[1] — `kb.write` с относительным путём `decisions/...`.
 *  - response[2] — финальный бриф.
 */

const PROMPT =
  'Запиши в продуктовую базу решение: для всех новых форм используем inline-валидацию, без модальных окон с ошибками.';
const TITLE = 'Inline-валидация в формах';
const DECISION_REL_PATH = 'decisions/2026-04-26-inline-validation.md';
const DECISION_CONTENT = `---
type: decision
created: 2026-04-26
updated: 2026-04-26
related: []
---

# Inline-валидация в формах

## Контекст
Команда хочет единообразный подход к показу ошибок ввода во всех новых формах.

## Решение
Используем inline-подсказки под/около поля. Модальные окна с ошибками не используем.

## Последствия
Дизайн-система должна предоставить токены для inline-ошибок; разработчики обязаны добавлять aria-описания.
`;

const BRIEF = `# Inline-валидация в формах

## Проблема
Разные команды показывают ошибки ввода по-разному, что путает пользователей.

## Целевой пользователь и сценарий
Любой пользователь, заполняющий форму на сайте.

## User stories
- Как пользователь, я хочу видеть ошибку рядом с полем, чтобы сразу понять, что исправить.

## Acceptance criteria
1. Все новые формы используют inline-подсказки.
2. Модальные окна с ошибками валидации не используются.

## Не-цели
- Переделка существующих форм за один спринт.

## Связанные артефакты kb
- product/decisions/2026-04-26-inline-validation.md`;

test('TC-19: kb.write с относительным путём попадает строго под .agents/knowledge/product/', async ({
  agent,
  workspacePath,
}) => {
  // 1. Сценарий: title → kb.write → бриф. Главное — что path в
  //    tool_call'е НЕ содержит префикса `product/`. Обёртка должна его
  //    добавить незаметно для модели.
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.write', { path: DECISION_REL_PATH, content: DECISION_CONTENT }, 'call_w'),
      fakeFinalAnswer(BRIEF)
    )
  );

  // 2. Ключ + старт.
  await agent.setApiKey();
  await agent.createRun(PROMPT);
  await agent.waitForBrief();

  const run = agent.lastRun();

  // 3a. kb.write успешно отработал.
  expectToolCalled(run, 'kb.write');
  expectToolSucceeded(run, 'kb.write');

  // 3b. В `tools.jsonl` аргумент `path` сохранился как пришёл от модели,
  //     БЕЗ префикса `product/`. Это контракт: модель не должна знать
  //     про существование префикса; обёртка добавляет его на уровне
  //     handler'а. Если бы tools.jsonl содержал `product/decisions/...`
  //     — это был бы лик абстракции в лог.
  const writeCall = run.toolEvents
    .flatMap((event) => event.tool_calls ?? [])
    .find((call) => call.name === 'kb.write');
  expect(writeCall, 'kb.write tool_call в tools.jsonl').toBeTruthy();
  const args = JSON.parse(writeCall!.arguments) as { path: string };
  expect(args.path, 'модель пишет относительный путь, без префикса роли').toBe(DECISION_REL_PATH);

  // 3c. Главный инвариант: файл лежит под product/, с правильным
  //     содержимым. expectKnowledgeFile принимает путь относительно
  //     корня knowledge — поэтому проверяем `product/decisions/...`.
  expectKnowledgeFile(run, `product/${DECISION_REL_PATH}`, DECISION_CONTENT);

  // 3d. Антипроверка: файла «голым путём» (без префикса роли) на диске
  //     быть не должно. Если бы обёртка не сработала и файл попал в
  //     `.agents/knowledge/decisions/...` — мы бы не заметили этого
  //     через expectKnowledgeFile (он проверяет только наличие в
  //     указанной точке). Поэтому явно ходим в fs.
  const wrongPath = path.join(workspacePath, '.agents', 'knowledge', DECISION_REL_PATH);
  expect(fs.existsSync(wrongPath), 'файл не должен оказаться в knowledge без префикса роли').toBe(
    false
  );

  // 4. Финал на месте, бриф ссылается на свежий decision.
  expectFinalAssistantText(run);
  expectRunStatus(run, 'awaiting_human');
  expect(run.brief).toContain(`product/${DECISION_REL_PATH}`);
});
