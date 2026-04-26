import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectKnowledgeFile,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
  expectChatHasNoToolCalls,
} from '../dsl/run-assertions';

/**
 * TC-11. Tool-loop: успешный цикл с одним kb.write.
 *
 * Стартовое состояние: ключ задан, доступна тестовая команда
 * `AI Frontend Agent: Run Tool Loop Smoke` (palette).
 *
 * Шаги:
 *   1. Палитра → `AI Frontend Agent: Run Tool Loop Smoke`.
 *   2. Ввести prompt вида `Создай в kb файл note.md с текстом "hello"`.
 *
 * Ожидание:
 *   - В `.agents/runs/<id>/tools.jsonl` появились записи: минимум одна
 *     `assistant` с `tool_calls`, одна `tool_result` (успех `kb.write`),
 *     финальная `assistant` без `tool_calls`.
 *   - В `.agents/knowledge/<path>` лежит файл с ожидаемым содержимым.
 *   - В `chat.jsonl` появилась только финальная reply агента — внутренние
 *     tool_calls туда НЕ дублируются.
 *   - Статус рана: `running → awaiting_human` (для smoke — финальный
 *     «успех», approve-кнопок нет).
 */

// Текст, который пользователь набирает в input box smoke-команды.
// Это и есть «задача», которую увидит модель.
const PROMPT = 'Создай smoke/note.md с текстом "hello"';

// Путь к файлу относительно папки `.agents/knowledge/` (sandbox).
// Именно его модель должна попросить kb.write создать.
const NOTE_PATH = 'smoke/note.md';

// Содержимое, которое мы ожидаем увидеть в созданном файле.
const NOTE_CONTENT = 'hello';

test('TC-11: tool-loop пишет файл через kb.write и завершается успехом', async ({ agent }) => {
  // 1. Заранее «программируем» поведение модели OpenRouter.
  //    Реальная сеть не дёргается — test-extension перехватывает fetch
  //    и отдаёт эти ответы по очереди.
  //    Сценарий из двух шагов:
  //      - первым ответом модель просит вызвать kb.write с нашими аргументами;
  //      - вторым ответом — отдаёт финальный текст без tool_calls,
  //        что для agent-loop'а означает «цикл завершён».
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('kb.write', { path: NOTE_PATH, content: NOTE_CONTENT }),
      fakeFinalAnswer(`Создал ${NOTE_PATH}.`)
    )
  );

  // 2. Открываем палитру команд и задаём API-ключ через настоящий
  //    showInputBox VS Code. Идём ровно тем же путём, что живой
  //    пользователь: палитра → команда → ввод значения → Enter.
  //    Значение ключа неважно: запросы всё равно перехватывает мок.
  await agent.setApiKey();

  // 3. Запускаем smoke-команду tool-loop'а через палитру и вводим
  //    prompt в её input box. После Enter agent-loop стартует и
  //    делает первый запрос «к OpenRouter» — который перехватит мок.
  await agent.runSmoke(PROMPT);

  // 4. Ждём, пока на экране появится notification «Smoke OK …» —
  //    это сигнал расширения, что цикл завершился успехом.
  //    Если произойдёт ошибка/таймаут, тест упадёт здесь.
  await agent.waitForCompletion();

  // 5. Достаём единственный созданный ран. Дальше работаем с его
  //    артефактами на диске (`.agents/runs/<id>/...`) и проверяем,
  //    что внутри лежит ровно то, что мы ожидаем.
  const run = agent.lastRun();

  // 5a. В логе тулов должна быть запись «модель просила вызвать kb.write».
  //     Это assistant-событие с tool_calls в `tools.jsonl`.
  expectToolCalled(run, 'kb.write');

  // 5b. И там же — успешный результат вызова kb.write
  //     (tool_result без поля `error`).
  expectToolSucceeded(run, 'kb.write');

  // 5c. Финальное assistant-событие НЕ должно содержать tool_calls —
  //     это инвариант «цикл реально остановился, а не висит».
  expectFinalAssistantText(run);

  // 5d. Файл, который модель попросила записать, физически лежит на
  //     диске в knowledge-песочнице с правильным содержимым.
  expectKnowledgeFile(run, NOTE_PATH, NOTE_CONTENT);

  // 5e. В пользовательском чате (chat.jsonl) сохранён исходный
  //     prompt — именно то, что ввёл «пользователь».
  expectChatHasUserPrompt(run, PROMPT);

  // 5f. И там же — финальный ответ агента (запись с `from: 'agent:*'`).
  expectChatHasAgentReply(run);

  // 5g. Внутренние tool_calls в пользовательский чат НЕ протекли —
  //     они должны жить только в tools.jsonl, не в chat.jsonl.
  //     Это контракт: пользователь видит «человеческую» ленту,
  //     а инженерные детали скрыты.
  expectChatHasNoToolCalls(run);
});
