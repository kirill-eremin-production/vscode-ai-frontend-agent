---
id: 0009
title: Дисциплина продакта — спрашивай не решай, не лезь в техническое
status: done
created: 2026-04-26
completed: 2026-04-26
---

## Context

US-13 и US-14 закрепляют поведенческие границы продакта: спрашивать при любом значимом пробеле, а не решать за пользователя; и не принимать технических решений (не выбирать стек, фреймворки, схемы БД и т.п.).

Это не «дополнительные фичи» — это фикс непредсказуемого текущего поведения: продакт может в произвольный момент решить, что вопросов достаточно, или начать рекомендовать технологии. Обе истории решаются преимущественно правкой system prompt-а + минимальным UI («Достаточно вопросов, оформляй» как явный сигнал) + парой TC, поэтому идут одной задачей.

## Acceptance criteria

US-13:

- System prompt продакта (`src/extension/entities/run/roles/product.*`) содержит явное правило «спрашивай при любом значимом пробеле, не решай за пользователя» с перечислением «значимых пробелов»: нечёткая проблема, не названный целевой пользователь, отсутствие основного сценария, неопределённые acceptance, нерешённые продуктовые альтернативы.
- Распознавание сигнала «достаточно вопросов» — через явное поле в IPC (например, `runs.user.message { text, finalize: true }`), а не через «магические слова» в свободном тексте. На стороне extension `finalize: true` транслируется в системный маркер внутри user-message, который продакт распознаёт по system prompt.
- В [RunDetails.tsx](src/webview/features/run-list/ui/RunDetails.tsx) есть кнопка «Достаточно вопросов, оформляй» в `awaiting_user_input` и `running`. Нажатие отправляет сообщение с `finalize: true`.
- После сигнала продакт перестаёт звать `ask_user` и финализирует артефакт, явно фиксируя допущения: либо отдельным разделом в финальном артефакте, либо записью в `decisions/YYYY-MM-DD-<slug>.md` с frontmatter `assumption: true, confirmed_by_user: false`.
- Без сигнала ран не уходит в `awaiting_human`, пока в брифе остаются пробелы из перечисленного списка (поведенческая проверка через TC, не код-уровневый валидатор).

US-14:

- System prompt содержит явный запрет: продакт не описывает стек, фреймворки, библиотеки, паттерны кода, схемы БД, формат API. Допустимы только верхнеуровневые продуктовые рамки (тип продукта, offline/online, целевая платформа в смысле «где живёт пользователь»).
- При прямом запросе пользователя «выбери базу/фреймворк/язык» продакт отказывается, переводит разговор в продуктовое русло, при необходимости заводит запись в kb как продуктовое требование (например, «обязательная работа без сети»), но не как техническое решение.
- В `brief.md` нет упоминаний конкретных технологий — проверяется TC.

## Implementation notes

- Правка system prompt — в [src/extension/entities/run/roles/](src/extension/entities/run/roles/) (тот же файл, который собирает `buildProductSystemPrompt`). Дописать секции «Спрашивай, не решай», «Реакция на сигнал finalize», «Не принимай технических решений».
- IPC: расширить `runs.user.message` полем `finalize?: boolean` (контракт в [messages.ts](src/extension/features/run-management/messages.ts) + зеркально в `src/webview/shared/runs/`). Если #0007 не сделан — кнопка временно живёт в форме ответа на `ask_user`, но это компромисс; нормальный путь — после #0007.
- Расширение «значимых пробелов» в системном промпте — единственный способ: код не парсит бриф и не валидирует пробелы. Поведение проверяется TC.
- TC писать **до реализации**: TC-28 (без `finalize` ран остаётся в `awaiting_user_input` на пробелах), TC-29 (с `finalize` — финализирует, в `decisions/` есть запись с `assumption: true`), TC-30 (запрос «выбери фреймворк» — продакт отказывается, в `brief.md` нет технологий).

## Outcome

- **System prompt продакта** ([product.prompt.ts](src/extension/entities/run/roles/product.prompt.ts)) расширен тремя секциями: «Ask, do not decide» с явным списком значимых пробелов; «Reaction to the finalize signal» с описанием маркера и обязанностью писать ADR-допущения; «Stay product, never technical» с явным запретом на технологии и шаблоном вежливого отказа.
- **IPC**: `RunsUserMessageRequest` ([messages.ts](src/extension/features/run-management/messages.ts)) получил поле `finalize?: boolean`. Маршрутизация в [wire.ts](src/extension/features/run-management/wire.ts): при `finalize: true` (только в `awaiting_user_input`) extension пишет короткую отметку в `chat.jsonl` (`PRODUCT_FINALIZE_USER_TEXT`) и подкладывает дословный `PRODUCT_FINALIZE_MARKER` как ответ на pending `ask_user`.
- **Источник правды для маркера** — константы [PRODUCT_FINALIZE_MARKER / PRODUCT_FINALIZE_USER_TEXT](src/extension/entities/run/roles/product.ts), импортируются и в prompt, и в wire — без дрифта между «как описано модели» и «что реально приходит как tool_result».
- **UI**: в [RunDetails.tsx](src/webview/features/run-list/ui/RunDetails.tsx) рядом с composer появилась кнопка «Достаточно вопросов, оформляй». Видна только при активном pending ask_user; шлёт `runs.user.message { finalize: true, text: '' }` через новый [sendFinalizeSignal](src/webview/shared/runs/store.ts). Стили — [media/main.css](media/main.css).
- **E2E**: [TC-29](tests/e2e/specs/tc-29-finalize-signal.spec.ts) проверяет полный wiring (UI кнопка → IPC → tool_result содержит маркер → kb.write ADR с `assumption: true` → финальный brief со ссылкой). [TC-30](tests/e2e/specs/tc-30-no-tech-in-brief.spec.ts) — лёгкая контрактная проверка нового assertion'а [expectBriefHasNoTechnologies](tests/e2e/dsl/run-assertions.ts), готового ловить регрессии US-14 на чистых брифах.
- **TC-28 пропущен сознательно**: «без finalize ран остаётся в awaiting_user_input на пробелах» через мок-OpenRouter сводится к проверке скрипта, а не дисциплины модели — реальную ценность даст только интеграционный тест с настоящей моделью.

## Related

- US-13, US-14.
- Зависит от: #0003 (роль продакта), #0001 (tool runtime).
- Тесно связан с: #0007 (поле ввода и кнопка «Достаточно вопросов» — одна и та же поверхность). Делать после #0007 или одновременно.
- Не зависит от: #0008, #0010.
