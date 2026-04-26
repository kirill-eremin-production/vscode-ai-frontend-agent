import * as fs from 'node:fs';
import type { Page } from '@playwright/test';
import { runCommand, fillInputBox, waitForNotification } from '../helpers/commands';
import { openAgentPanel, agentWebviewContent } from '../helpers/webview';
import type { FakeScenario } from './scenario';
import { RunArtifacts, listRuns } from './run-artifacts';

/**
 * High-level фасад над VS Code и сценарным fake-OpenRouter.
 *
 * Идея: тест декларативно описывает «что должен сделать пользователь»
 * и «что мы ожидаем», не зная про селекторы Quick Pick, формат
 * сценария и пути на диске. Все низкоуровневые детали живут здесь.
 *
 * Создаётся фикстурой, см. `fixtures/agent.ts`.
 */
export class AgentDriver {
  constructor(
    private readonly window: Page,
    private readonly workspacePath: string,
    private readonly scenarioPath: string
  ) {}

  /** Подсистема перехвата OpenRouter — отдельный namespace для читаемости. */
  readonly openRouter = {
    /**
     * Установить сценарий ответов модели. Перезаписывает файл на диске —
     * test-extension перечитает его при следующем fetch.
     */
    respondWith: (scenario: FakeScenario): void => {
      fs.writeFileSync(this.scenarioPath, JSON.stringify(scenario), 'utf8');
    },
  };

  /**
   * Задать API-ключ через настоящий showInputBox. Идём по тому же пути,
   * что и пользователь — палитра → команда → ввод значения.
   *
   * Значение ключа здесь не важно: реальные запросы заворачивает
   * fake-fetch, ему ключ безразличен. Передаём правдоподобный, чтобы
   * валидация на стороне расширения (если появится) не падала.
   */
  async setApiKey(value = 'sk-or-fake-key-for-tests'): Promise<void> {
    await runCommand(this.window, 'AI Frontend Agent: Set OpenRouter API Key');
    await fillInputBox(this.window, value);
  }

  /**
   * Запустить smoke-команду tool-loop'а с заданным prompt'ом.
   * НЕ ждёт завершения — это делает `waitForCompletion` отдельно,
   * чтобы тест мог между запуском и финалом проверить промежуточные
   * состояния (TC-15: ask_user, TC-16: durability).
   */
  async runSmoke(prompt: string): Promise<void> {
    await runCommand(this.window, 'AI Frontend Agent: Run Tool Loop Smoke');
    await fillInputBox(this.window, prompt);
  }

  /**
   * Дождаться успешного финала smoke-цикла.
   * Smoke-команда показывает notification «Smoke OK …» по завершении
   * (см. tool-loop-smoke/command.ts:finalizeRun).
   */
  async waitForCompletion(): Promise<void> {
    await waitForNotification(this.window, 'Smoke OK');
  }

  /**
   * Дождаться нотификации о провале smoke-цикла.
   * Используется в тестах, где сценарий специально приводит к failed
   * (например, лимит итераций).
   */
  async waitForFailure(): Promise<void> {
    await waitForNotification(this.window, 'Smoke failed');
  }

  /**
   * Достать единственный ран в workspace. Падает, если ранов 0 или >1
   * — это сразу видно как ошибку теста, а не как «непонятно, какой
   * ран я смотрю».
   */
  lastRun(): RunArtifacts {
    const runs = listRuns(this.workspacePath);
    if (runs.length === 0) {
      throw new Error('[agent] В workspace нет ни одного рана');
    }
    if (runs.length > 1) {
      throw new Error(
        `[agent] В workspace ${runs.length} ранов — используй listAllRuns(), если это ожидаемо`
      );
    }
    return runs[0];
  }

  /** Все раны в workspace — для тестов, где их заведомо несколько. */
  listAllRuns(): RunArtifacts[] {
    return listRuns(this.workspacePath);
  }

  /**
   * Создать ран через webview-форму («Start run»). В отличие от
   * `runSmoke` (где есть слеш-команда), у обычного рана нет
   * палитровой команды — это сознательно, продуктовый поток UI идёт
   * через панель. Поэтому открываем UI и нажимаем кнопку.
   *
   * Не ждёт окончания цикла — для этого есть `waitForBrief` /
   * `waitForRunStatus`. Так тест может между стартом и финалом
   * проверить промежуточные состояния (TC-18: ask_user, TC-20:
   * durability).
   */
  async createRun(prompt: string): Promise<void> {
    await this.openSidebar();
    const ui = agentWebviewContent(this.window);
    await ui.locator('.run-create__input').fill(prompt);
    await ui.locator('.run-create button[type="submit"]').click();
  }

  /**
   * Дождаться появления `brief.md` на диске единственного рана.
   * Используется как сигнал «продакт довёл цикл до финала и записал
   * артефакт». Опираемся на fs, а не на статус в `meta.json`, потому
   * что у статуса временное окно `running → awaiting_human` короче,
   * чем у файла на диске (после `writeBrief` ещё пишется чат и мета).
   */
  async waitForBrief(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = listRuns(this.workspacePath);
      if (runs.length > 0 && runs[0].brief !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`[agent] За ${timeoutMs} мс не появился brief.md ни у одного рана`);
  }

  /**
   * Дождаться, пока статус единственного рана дойдёт до заданного.
   * Альтернатива `waitForBrief` для случаев, когда финал — `failed`
   * (брифа не будет, но статус мы всё равно увидим).
   */
  async waitForRunStatus(status: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = listRuns(this.workspacePath);
      if (runs.length > 0 && runs[0].meta?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`[agent] За ${timeoutMs} мс ран не достиг статуса "${status}"`);
  }

  /**
   * Дождаться, пока в `tools.jsonl` единственного рана появится
   * assistant-событие с tool_call'ом нужного тула. Polling по диску —
   * самый дешёвый способ синхронизации с agent-loop'ом, не зависящий
   * от webview/broadcast'ов.
   *
   * Используется в durability-тестах: «дойди до точки приостановки,
   * потом я тебя выключу». Без этой проверки риск убить процесс
   * раньше, чем fake-fetch успеет прорезаться через цикл.
   */
  async waitForAssistantToolCall(toolName: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = listRuns(this.workspacePath);
      if (runs.length > 0) {
        const found = runs[0].toolEvents.find(
          (event) =>
            event.kind === 'assistant' && event.tool_calls?.some((call) => call.name === toolName)
        );
        if (found) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `[agent] За ${timeoutMs} мс не дождались assistant-события с tool_call ${toolName}`
    );
  }

  /**
   * Открыть панель агента отдельной вкладкой редактора и подождать,
   * пока React-приложение успеет смонтироваться. После этого можно
   * выбирать раны и отвечать на вопросы.
   *
   * Метод оставлен под именем `openSidebar`, чтобы спеки не пришлось
   * массово править: семантически они открывают «UI агента», а уж
   * sidebar или таб — деталь реализации.
   */
  async openSidebar(): Promise<void> {
    await openAgentPanel(this.window);
    // Ждём, пока React успел отрендерить хотя бы заголовок RunList.
    // Если webview только-только вставился — `frameLocator` уже работает,
    // но содержимое ещё пустое; спецы дальше поедут раньше времени.
    const ui = agentWebviewContent(this.window);
    await ui.locator('.run-list, .run-list--empty').first().waitFor({
      state: 'visible',
      timeout: 15_000,
    });
  }

  /**
   * Выбрать ран в списке сайдбара по его id (точное совпадение
   * `<li data-id={id}>` нет — кликаем по заголовку, отфильтрованному
   * через has-text c началом id'а; smoke-id'ы достаточно уникальны
   * в рамках одного теста).
   *
   * Открыть карточку нужно, чтобы увидеть AskUserForm: pendingAsk
   * хранится в store, но рендерится только для selectedRun.
   */
  async selectRun(runId: string): Promise<void> {
    const ui = agentWebviewContent(this.window);
    // RunList'у достаточно «известного» начала id — он печатает title,
    // в title живёт префикс `[smoke] <prompt>`. Чтобы не зависеть от
    // title, мапим на runId через DOM. Сейчас RunList не выставляет
    // data-id, но title содержит начало prompt'а, а id мы знаем
    // только из артефакта на диске. Плюхаемся через position:
    // в большинстве TC-15/16 ран ровно один — берём первый item.
    void runId;
    const firstItem = ui.locator('.run-list__item').first();
    await firstItem.waitFor({ state: 'visible', timeout: 15_000 });
    await firstItem.click();
  }

  /**
   * Дождаться появления баннера ask_user внутри webview и убедиться,
   * что в нём нужный вопрос. Сам ввод ответа теперь идёт через общий
   * composer (`sendUserMessage`), а баннер — visual-only элемент.
   */
  async waitForAskUserForm(question: string): Promise<void> {
    const ui = agentWebviewContent(this.window);
    const banner = ui.locator('.run-details__ask');
    await banner.waitFor({ state: 'visible', timeout: 30_000 });
    await ui
      .locator('.run-details__ask-question', { hasText: question })
      .waitFor({ state: 'visible', timeout: 5_000 });
  }

  /**
   * Ответить на текущий ask_user через общий composer.
   *
   * После #0007 поле ввода стало единым: один composer обслуживает и
   * ответ на ask_user (в `awaiting_user_input`), и продолжение диалога
   * (в `awaiting_human`/`failed`). Селекторы соответствующие — `composer`,
   * не `ask`. Семантика метода сохранена для уже написанных TC-15..21.
   */
  async answerAsk(text: string): Promise<void> {
    await this.sendUserMessage(text);
  }

  /**
   * Отправить любое сообщение пользователя через composer. Используется
   * и для ответа на вопрос, и для продолжения диалога после
   * `awaiting_human` (US-10, TC-22).
   */
  async sendUserMessage(text: string): Promise<void> {
    const ui = agentWebviewContent(this.window);
    const input = ui.locator('.run-details__composer-input');
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.fill(text);
    await ui.locator('.run-details__composer-submit').click();
  }

  /**
   * Кликнуть по ссылке на файл в карточке tool_result и дождаться,
   * пока VS Code откроет соответствующую вкладку редактора. Используется
   * в TC-23 (видимость созданных файлов в ленте, US-11).
   */
  async openFileFromToolEntry(relativePathFromKb: string): Promise<void> {
    const ui = agentWebviewContent(this.window);
    const link = ui.locator('.run-details__file-link', { hasText: relativePathFromKb });
    await link.waitFor({ state: 'visible', timeout: 30_000 });
    await link.click();
  }

  /**
   * Дождаться появления tool-карточки с указанным именем тула в ленте.
   * Лента мерджит chat.jsonl + tools.jsonl по timestamp, а карточки
   * рендерятся по `runs.tool.appended`-broadcast'ам — это синхронизация
   * с UI без обращения к диску.
   */
  async waitForToolEntry(toolName: string): Promise<void> {
    const ui = agentWebviewContent(this.window);
    await ui
      .locator('.run-details__entry--tool', { hasText: toolName })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  }
}
