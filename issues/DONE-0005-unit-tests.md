---
id: 0005
title: Unit-тесты для детерминированного ядра (vitest)
type: infrastructure
status: done
created: 2026-04-26
---

## Outcome

Реализовано: vitest 4 + `npm run test:unit`, конфиг `vitest.config.ts`, мок `vscode` в `tests/setup-vscode.ts`. 52 unit-теста покрывают:

- `entities/run/storage.ts` — `resolveKnowledgePath`, `findPendingAsk`, atomic write `meta.json`/`loop.json`.
- `shared/agent-loop/validator.ts` — валидация + кеш схем по имени тула.
- `shared/agent-loop/resume.ts` — `reconstructHistory` (все ветки событий).
- `shared/agent-loop/pending-asks.ts` — полный жизненный цикл реестра.
- `shared/agent-loop/tools/kb.ts` — read/write/list/grep на `os.tmpdir()`, sandbox, лимит 100, скип бинарных расширений.

## Сюта проходит за ~50ms. AGENT.md обновлён (раздел «Тесты»).

## Context

Кодовая база растёт, один человек уже не успевает ревьюить всё руками. Без автоматических тестов любая правка ядра (storage, sandbox, валидатор, resume) рискует молча сломать TC-11..16 и обнаружиться только в ручной проверке через несколько коммитов.

Unit-тесты — самый дешёвый слой: ядро у нас детерминированное, не требует VS Code runtime, не требует сети. Покрытием unit'ов закрываем большую часть логики; всё, что завязано на webview/IPC/реальный OpenRouter, остаётся за e2e (#0006).

## Acceptance criteria

- В проект добавлен `vitest` (dev-dep) + npm-скрипт `test:unit`. Конфиг — `vitest.config.ts`, jsdom не нужен (всё — node-сторона).
- Unit-тесты лежат в `src/**/*.test.ts` рядом с тестируемым кодом (не в отдельной `tests/` — это про manual). ESLint-границы тесты не должны нарушать.
- Покрыты как минимум:
  - `entities/run/storage.ts` — `resolveKnowledgePath` (sandbox: `..`, абсолютные пути, символы должны отвергаться), `findPendingAsk` (нет ask → undefined; ask без ответа → возвращается; ask с ответом → undefined), атомарная запись `meta.json` / `loop.json` (temp + rename, неполный файл не остаётся при «падении» в середине — мокаем fs).
  - `shared/agent-loop/validator.ts` — валидные входы пропускаются, невалидные дают `{ ok: false, error }`, кеш компиляции по имени тула.
  - `shared/agent-loop/resume.ts` — `reconstructHistory` корректно собирает ChatMessage[] из `LoopConfig` + событий, ответ пользователя приклеивается как `role: "tool"` к нужному `tool_call_id`.
  - `shared/agent-loop/pending-asks.ts` — register/resolve/reject, повторный resolve возвращает false.
  - `shared/agent-loop/tools/kb.ts` — read/write/list/grep работают на временной директории (`os.tmpdir()`), запрос за пределы sandbox даёт ошибку валидации/исполнения, kb.write атомарен.
- `npm run test:unit` зелёный локально и проходит как часть pre-commit (lint-staged) **только для затронутых файлов**, либо как отдельный шаг — решить при реализации.
- Документация: короткий раздел в `AGENT.md` «Тесты», ссылка на скрипт, правило «при правке покрытого модуля синхронно правь и тест».

## Implementation notes

- Для fs-тестов используем реальный `os.tmpdir()` + уникальную директорию на тест (через `crypto.randomUUID`), очищаем в `afterEach`. Моки fs тащат ложную сложность, реальные временные файлы быстрее и надёжнее.
- Не пишем тесты на VS Code API (нет смысла без `@vscode/test-electron`) — для этого e2e #0006.
- Цель — детерминированность и скорость: вся unit-сюта должна укладываться в 1–2 секунды, иначе никто не будет гонять её на каждый файл.

## Related

- #0006 — e2e-тесты (комплементарны, не дублируют unit'ы).
- TC-11..16 в `tests/manual-test-cases.md` — частично формализуются в unit'ах, остальное уходит в e2e.
