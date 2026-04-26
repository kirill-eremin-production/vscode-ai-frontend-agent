import { test } from '../fixtures/agent';
import { scenario, fakeFinalAnswer } from '../dsl/scenario';
import { expectRunStatus } from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-21. Продакт: фейл-режим — US-7.
 *
 * Сценарий обрывается короче, чем нужно agent-loop'у: модель отдаёт
 * заголовок (первый запрос) и… всё. Продактовый цикл делает второй
 * запрос — fake-fetch отвечает 500 с диагностикой «сценарий исчерпан»
 * (см. tests/e2e/test-extension/extension.js). `runAgentLoop` ловит
 * ошибку OpenRouter и возвращает `kind: 'failed'`; `finalizeRun`
 * продакта ставит статус `failed`, пишет system-сообщение в чат,
 * brief.md НЕ создаёт.
 *
 * Это проверка ключевого инварианта роли: при сбое сети/провайдера
 * ран не висит вечно в `running`, а корректно переходит в `failed`
 * с диагностикой. Без явного теста легко закралась бы регрессия в
 * `runProduct.finalizeRun`-обработке `kind: 'failed'`.
 *
 * Другие фейл-режимы (отмена ввода ключа, пустой assistant.content)
 * остаются ручными — их сложно надёжно автоматизировать без отдельной
 * инфраструктуры мокирования input box / keychain. Описаны в
 * TC-21 manual-варианте, который мы заменили на этот файл; см.
 * историю git до коммита #0003.
 */

const PROMPT = 'Сделай страницу настроек профиля.';
const TITLE = 'Страница настроек профиля';

test('TC-21: при ошибке OpenRouter в продактовом цикле ран уходит в failed без brief.md', async ({
  agent,
}) => {
  // 1. Сценарий ровно из ОДНОГО ответа: только заголовок. Когда продакт
  //    сделает свой первый chat()-запрос, fake-fetch отдаст 500 с
  //    «сценарий исчерпан» — именно это и моделирует сетевой/серверный
  //    сбой провайдера во время цикла.
  agent.openRouter.respondWith(scenario(fakeFinalAnswer(TITLE)));

  // 2. Старт обычного рана через UI.
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3. Ждём, пока ран дойдёт до `failed`. `waitForBrief` тут не
  //    подойдёт — brief.md в этом сценарии не должен появиться.
  await agent.waitForRunStatus('failed');

  const run = agent.lastRun();

  // 4a. brief.md не создан: продакт даже не дошёл до финального
  //     assistant.content, нечего было сохранять.
  expect(run.brief, 'brief.md не должен появиться при провале цикла').toBeUndefined();

  // 4b. В `tools.jsonl` есть system-событие про ошибку OpenRouter
  //     (его пишет `runAgentLoop`, а не roling-слой). По нему диагностика
  //     дальше едет в чат.
  const errorEvent = run.toolEvents.find(
    (event) =>
      event.kind === 'system' &&
      typeof event.message === 'string' &&
      /OpenRouter/.test(event.message)
  );
  expect(errorEvent, 'Ожидали system-событие OpenRouter в tools.jsonl').toBeTruthy();

  // 4c. В `chat.jsonl` есть человекочитаемая диагностика от
  //     `agent:system` («Продакт упал: …»). Без неё пользователь не
  //     понял бы, что произошло, без открытия лога.
  const sysMsg = run.chat.find((entry) => entry.from === 'agent:system');
  expect(sysMsg, 'Ожидали сообщение agent:system в chat.jsonl').toBeTruthy();
  expect(sysMsg!.text).toMatch(/упал|failed|ошибка/i);

  // 4d. Заголовок успел сгенерироваться нормально (response[0]) — это
  //     убеждает, что фейл случился именно в продактовом цикле, а не
  //     раньше (например, в title-генерации).
  expect(run.meta?.title).toBe(TITLE);
  expectRunStatus(run, 'failed');
});
