'use strict';

/**
 * E2E test-helper extension.
 *
 * Назначение — единственное и максимально узкое: подменить `globalThis.fetch`
 * так, чтобы запросы к OpenRouter не уходили в сеть, а возвращали
 * сценарные ответы из JSON-файла. Всё остальное продолжает работать
 * как обычно — мы НЕ патчим vscode API, не подменяем секреты, не лезем
 * в storage. Это намеренно: чем меньше поверхностей подмены, тем
 * меньше расхождение с продом.
 *
 * Расширение активируется только когда VS Code запущен с
 * `--extensionDevelopmentPath` указывающим на эту папку (то есть в
 * Playwright-фикстуре). В обычной установке его не существует.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Путь к JSON-файлу со сценарием передаётся через env-переменную. */
const SCENARIO_ENV = 'AI_FRONTEND_AGENT_FAKE_OPENROUTER_SCENARIO';

/**
 * Один ответ модели в сценарии. Поля повторяют контракт OpenRouter
 * Chat Completions, чтобы сценарий читался один-в-один с тем, что
 * увидел бы реальный клиент. Поддерживаем только то, что реально
 * читает наш `chat()`-клиент.
 *
 * @typedef {Object} FakeChoice
 * @property {{ role: 'assistant', content: string|null, tool_calls?: any[] }} message
 * @property {string} [finish_reason]
 *
 * @typedef {Object} FakeResponse
 * @property {string} [model]
 * @property {FakeChoice[]} choices
 * @property {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} [usage]
 *
 * @typedef {Object} Scenario
 * @property {FakeResponse[]} responses
 */

/**
 * Загрузить сценарий из файла. Делаем это лениво при первом запросе:
 * во-первых, активация расширения не должна падать из-за отсутствия
 * сценария (если переменная не задана — просто не патчим fetch);
 * во-вторых, тест может перезаписать файл между прогонами в одной
 * сессии VS Code.
 *
 * @param {string} scenarioPath
 * @returns {Scenario}
 */
function loadScenario(scenarioPath) {
  const raw = fs.readFileSync(scenarioPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.responses)) {
    throw new Error(
      `[e2e-helper] Сценарий ${scenarioPath} невалиден: ожидалось { responses: [...] }`
    );
  }
  return parsed;
}

/**
 * Установить fake-fetch. Перехватываем только запросы на openrouter.ai
 * — всё остальное (telemetry, marketplace и т.п.) пропускаем как есть,
 * чтобы не сломать VS Code своими руками.
 */
function installFakeFetch(scenarioPath) {
  const realFetch = globalThis.fetch;
  let callIndex = 0;

  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url || !url.includes('openrouter.ai')) {
      return realFetch(input, init);
    }

    // Перечитываем сценарий на каждый запрос — тесту удобнее писать
    // файл прямо перед триггером действия, без перезапуска VS Code.
    const scenario = loadScenario(scenarioPath);
    const response = scenario.responses[callIndex];
    callIndex += 1;

    if (!response) {
      // Жёстко падаем, чтобы тест увидел проблему сразу: сценарий
      // короче, чем фактическое число запросов.
      const body = JSON.stringify({
        error: {
          message: `[e2e-helper] Сценарий исчерпан: запрос #${callIndex}, в файле ${scenario.responses.length} ответов`,
        },
      });
      return new Response(body, {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    const body = JSON.stringify({
      model: response.model ?? 'fake/scenario',
      choices: response.choices,
      usage: response.usage,
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  // Логируем активацию в Output, чтобы при разборе тестового прогона
  // было видно «да, fetch перехвачен».
  console.log(`[e2e-helper] OpenRouter fetch перехвачен; сценарий: ${scenarioPath}`);
}

/**
 * Точка активации расширения. VS Code вызывает её один раз при старте
 * (activationEvents: onStartupFinished).
 */
function activate(_context) {
  const scenarioPath = process.env[SCENARIO_ENV];
  if (!scenarioPath) {
    console.log('[e2e-helper] Сценарий не задан — fetch НЕ перехватывается');
    return;
  }

  if (!path.isAbsolute(scenarioPath)) {
    throw new Error(
      `[e2e-helper] ${SCENARIO_ENV} должен быть абсолютным путём, получено: ${scenarioPath}`
    );
  }

  installFakeFetch(scenarioPath);
}

function deactivate() {
  // Восстанавливать `globalThis.fetch` смысла нет — extension host
  // умирает вместе с VS Code, а перехват должен жить всю сессию.
}

module.exports = { activate, deactivate };
