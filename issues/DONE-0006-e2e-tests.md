---
id: 0006
title: E2E-тесты на моках (full suite через Playwright + настоящий VS Code)
type: infrastructure
status: done
created: 2026-04-26
---

## Outcome

Реализовано: Playwright + `@vscode/test-electron` + `_electron.launch()` против настоящего VS Code (версия пина — 1.96.4 в `tests/e2e/global-setup.ts`). Перехват OpenRouter — отдельным test-extension (`tests/e2e/test-extension/`), патчит `globalThis.fetch` по env-переменной `AI_FRONTEND_AGENT_FAKE_OPENROUTER_SCENARIO`. Прод-код о тестах не знает.

Покрытие — TC-11..16 в `tests/e2e/specs/`:

- TC-11 — успешный tool-loop с `kb.write`.
- TC-12 — sandbox-нарушение в `kb.read` (path-traversal).
- TC-13 — невалидные входы тула (Ajv отбивает `kb.write` без `content`).
- TC-14 — превышение лимита итераций (20+ tool_call'ов подряд).
- TC-15 — `ask_user` end-to-end через webview-форму в editor-вкладке.
- TC-16 — durability `ask_user` через перезапуск VS Code (две сессии Electron, свежий `--user-data-dir` для второй, обрезка сценария по уже отыгранным ответам).

DSL для спек: `dsl/agent.ts` (фасад над VS Code), `dsl/scenario.ts`, `dsl/run-artifacts.ts`, `dsl/run-assertions.ts`, `dsl/session.ts` (`withVSCodeSession`/`prepareRestart` для durability). Helpers'ы DOM-локаторов — в `tests/e2e/helpers/`. Видео + trace включены всегда, аттачатся к HTML-отчёту. Изоляция — уникальные `--user-data-dir`/`--extensions-dir`/workspace на каждый тест.

Скрипты: `npm run test:e2e:full`, `:full:ui`, `:report`. AGENT.md обновлён (раздел «Тесты»).

## Решение по smoke на реальных моделях

Изначально задача предполагала второй контур — `test:e2e:smoke` с реальным OpenRouter-ключом и реальными моделями для критичных сценариев («модель действительно вызывает kb.write/ask_user»). От этого отказались.

Аргумент: цель e2e — проверить поведение нашего приложения при предположении, что модель исполняет контракт OpenRouter (корректные `tool_calls`/`finish_reason`). Это полностью покрывается mocked-сценариями. Тестировать реальные модели — значит тестировать качество моделей и стабильность промптов, что:

- нестабильно (модели вероятностные, gemini-flash-lite уже подводил с `ask_user`);
- стоит денег;
- делает CI flaky и приводит к тому, что красные тесты перестают смотреть.

Если когда-нибудь захочется ловить деградации промптов на проде — это будет отдельная задача (мониторинг/eval-набор), не часть e2e.

## Context

Unit-тесты (#0005) покрывают ядро, но не проверяют интеграцию: webview ↔ extension IPC, реальные команды VS Code, durability рана через перезапуск, поведение полной цепочки «команда → loop → tool → chat.jsonl → UI». Без e2e любой рефактор IPC или storage может тихо сломать TC-15/TC-16, и обнаружится это только при ручной проверке.

## Acceptance criteria (фактически выполнены)

- `@vscode/test-electron` + Playwright (вместо изначально предполагавшегося Mocha — Playwright дал HTML-репорт, trace viewer и `--ui` mode без доплаты). Скрипт `test:e2e:full`.
- E2E живут в `tests/e2e/`, каждый тест-кейс мапится на `TC-N` из `tests/e2e/specs/` (имя файла содержит `TC-N`).
- Перед каждым тестом — чистая временная workspace через `os.tmpdir()`+UUID, `.agents/runs/` тестов не пересекаются.
- Реализован fake OpenRouter transport через подмену `globalThis.fetch` в отдельном test-extension. Сценарий = массив ответов модели (`tools/e2e/dsl/scenario.ts`), на N-й запрос отдаётся N-й ответ. Поддержка `tool_calls`. Прод-код не патчили — единая точка подмены живёт вне основного расширения.
- Покрыты TC-11..16 (см. список в Outcome).
- Webview-проверки реализованы через настоящий webview в editor-вкладке (команда `AI Frontend Agent: Open in Tab`) + двойной `frameLocator` на `iframe.webview` → `iframe#active-frame`.

## Related

- #0005 — unit-тесты (фундамент, e2e не дублирует ядро).
- TC-11..16 в `tests/e2e/specs/` — формализованы в full suite.
- Будущее: CI (отдельная задача), запуск full e2e на каждый PR.
