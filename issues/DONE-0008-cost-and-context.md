---
id: 0008
title: Учёт стоимости и заполненности контекста, sessions storage layout
status: done
completed: 2026-04-26
---

## Context

US-12 даёт пользователю видимость по двум осям: сколько уже потратили (USD) и сколько ещё помещается в контекст конкретной модели. Без этого долгий ран — чёрный ящик.

В процессе обсуждения решили: «компактификация = бэкап `.bak`» (как в первой редакции тикета) — антипаттерн. Правильнее иметь **сессии** внутри рана, где компактификация создаёт новую сессию из summary, а старая остаётся read-only с возможностью просмотра через табы. Это так же подготавливает почву под мульти-агентский режим (#0012).

Поэтому #0008 разделили на две части:

- **Phase 1 (этот тикет)**: storage-схема `sessions/<sid>/` + cost/context tracking + UI с табами + индикатор контекста + кнопка «Сжать» (видимая, **disabled** до #0013).
- **#0013** — собственно компактификация: создание новой сессии из summary, React-модалка confirm.

## Acceptance criteria (Phase 1) — реализовано

- ✅ Storage layout: `runs/<id>/{meta.json, brief.md, sessions/<sid>/{meta.json, chat.jsonl, tools.jsonl, loop.json}}`. Brief остаётся per-run (перенос в kb — отдельный тикет #0011).
- ✅ Run-meta хранит `activeSessionId`, `sessions: SessionSummary[]` и агрегат `usage`.
- ✅ Session-meta хранит `kind`, `participants`, `parentSessionId?`, статус и per-session `usage`.
- ✅ Тарифы и контекст-лимиты — литералами в [product.ts](src/extension/entities/run/roles/product.ts) (`PRODUCT_PRICING = { inputPerMTok: 0.25, outputPerMTok: 1.5 }`, `PRODUCT_CONTEXT_LIMIT_TOKENS = 200_000`). Реестр-маппинг model→pricing/limit — [pricing/registry.ts](src/extension/shared/pricing/registry.ts), нужен для тестируемости (TC-27 «модель без тарифа»).
- ✅ Agent loop эмбеддит `usage` (model, prompt/completion/total tokens, costUsd) в каждое assistant-событие `tools.jsonl`. Параллельно обновляет per-session и per-run агрегаты через `addUsageToActiveSession`.
- ✅ Если у модели тариф не задан — `costUsd: null` и в шагах, и в агрегате (правило «один неизвестный тариф ⇒ итог неизвестен»). UI показывает «—», а не «$0».
- ✅ Если OpenRouter не вернул `usage` — assistant-событие пишется без поля, агрегат не трогаем; ран не ломаем.
- ✅ В UI [RunDetails.tsx](src/webview/features/run-list/ui/RunDetails.tsx):
  - шапка с total cost рана + токены (in/out);
  - индикатор заполненности контекста с цветовыми зонами (green <60%, yellow 60–85%, red >85%);
  - per-step usage badge на каждом assistant-событии в ленте;
  - полоса вкладок сессий (на Phase 1 одна — "Session 1", готова к множественным после #0013);
  - кнопка «Сжать контекст» — видна, disabled с tooltip «будет в #0013».

## Тесты — реализовано

- ✅ **Unit** (`storage.test.ts`): полный пересмотр под sessions-схему. 78 тестов проходят, включая:
  - `addUsageToActiveSession` накапливает токены и стоимость;
  - costUsd становится `null`, если хоть один шаг был на модели без тарифа (TC-27 на уровне unit);
  - `createSession` + `setActiveSession` готовы к #0013 (создаются вторая сессия, parentSessionId выставляется, статус рана = статус активной).
- ✅ **E2E** добавлены:
  - **TC-25** (`tc-25-usage-accumulates-and-survives-restart.spec.ts`): usage накапливается за 3 шага, переживает перезапуск VS Code; per-step usage эмбеддится в каждое assistant-событие.
  - **TC-27** (`tc-27-unknown-model-cost-null.spec.ts`): модель `unknown/test-pricing-model` → `costUsd: null` в шагах и агрегате, токены при этом считаются, ран доходит до `awaiting_human`.
- ✅ **TC-26** (компактификация) — заявлена в #0013, потому что относится к собственно `compactSession()`.
- ✅ Существующие TC (15..24, 29..30) подтянулись на новый layout автоматически — `run-artifacts.ts` теперь читает `sessions/<activeSessionId>/`. Новый ToolEvent.usage поле опциональное, старые тесты ничего не проверяют по нему.

## Implementation notes

- **Storage routing**: storage-функции (`appendChatMessage`, `appendToolEvent`, `readChat`, `readToolEvents`, `findPendingAsk`, `writeLoopConfig`, `readLoopConfig`, `updateRunStatus`) принимают `runId` и по умолчанию работают с активной сессией — внутри читают `meta.activeSessionId`. Минимизирует churn в consumer'ах. Явный `sessionId` принимается опционально (для тестов и будущей компактификации).
- **`updateRunStatus`** превращён в фасад над `setSessionStatus` для активной сессии. RunMeta.status синхронизируется зеркально — список ранов в UI не должен лезть в N session-meta.
- **`addUsageToActiveSession`** атомарно обновляет SessionMeta и RunMeta (через `persistSessionUpdate`). После каждого шага agent-loop'а broadcast'ится `runs.updated` с новой RunMeta — UI обновляет шапку без отдельного `runs.get`.
- **Webview duplicate of context limit**: `src/webview/shared/runs/pricing.ts` дублирует `200_000` из `product.ts`. ESLint-границы запрещают cross-импорт; вынос в shared package — на потом, когда будет более одной модели.

## Verification status

- ✅ `npm run build` — успешно (extension 175.5 KB, webview 206.3 KB).
- ✅ `npx tsc -p tsconfig.extension.json --noEmit` — без ошибок.
- ✅ `npx tsc -p tsconfig.webview.json --noEmit` — без ошибок.
- ✅ `npx eslint .` — без ошибок.
- ✅ `npx vitest run` — 78 / 78 проходят (8 новых из storage.test.ts).
- ⚠️ E2E (`npx playwright test`) на этой машине не запускается из-за environment-проблемы с VS Code 1.96.4 / Playwright Electron: `bad option: --remote-debugging-port=0`. Это ортогонально #0008 — все TC (включая существующие до этого тикета) на этом окружении не запускаются по той же причине. Тесты TC-25 и TC-27 написаны и проверяемы при работающем e2e окружении.

## Related

- US-12.
- Follow-ups: #0011 (brief в kb), #0012 (мульти-агент + редактирование истории), #0013 (компактификация — фактически активирует кнопку «Сжать»).
- Зависимости: #0001 (`runAgentLoop` — единая точка для usage учёта).
