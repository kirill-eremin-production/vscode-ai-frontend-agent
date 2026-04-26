---
id: 0007
title: Chat UX foundation — продолжение диалога и видимость тулов/файлов
status: done
created: 2026-04-26
completed: 2026-04-26
---

## Context

US-10 и US-11 расширяют чат рана из «лента read-only поверх артефакта» в полноценный итеративный диалог с прозрачностью инструментов. Без этого пользователь не может ни доработать `brief.md` без создания нового рана, ни увидеть, что именно сделал агент (и куда положил файлы).

Обе истории касаются одной поверхности — webview-ленты + IPC для нового user-message в любом «не-черновом» статусе — и архитектурно решаются одной задачей. Решать их по одной приведёт к двум разъезжающимся правкам одного и того же контракта.

Это фундамент для всего, что идёт дальше: архитектор (#0004) наследует ту же ленту, длинные итеративные раны (US-10) сразу упираются в лимит контекста (#0008).

## Acceptance criteria

US-10:

- В [src/webview/features/run-list/ui/RunDetails.tsx](src/webview/features/run-list/ui/RunDetails.tsx) есть постоянное поле ввода + кнопка «Отправить» в любом статусе (`running`, `awaiting_user_input`, `awaiting_human`, `failed`), но не в `draft`.
- Новое сообщение пользователя дописывается в `chat.jsonl` как `from: "user"` и поднимает агента той же роли на продолжение цикла. В `awaiting_user_input` сообщение служит ответом на текущий `ask_user` (см. US-8) — отдельной формы не плодим.
- `brief.md` (и будущие артефакты других ролей) перезаписывается атомарно через writer'ы из [storage.ts](src/extension/entities/run/storage.ts). Прежние редакции живут только в git.
- После `failed` отправка сообщения возобновляет ран с накопленным контекстом из `chat.jsonl` + `tools.jsonl`.

US-11:

- Лента в `RunDetails.tsx` показывает записи из `tools.jsonl` встык с `chat.jsonl` в едином timeline по timestamp. Отдельного лог-таба нет.
- Каждый tool call: имя, превью аргументов (раскрывается полностью по клику), статус (`ok`/`error`), превью результата, текст ошибки если упал.
- Для тулов, создающих/меняющих файлы (`kb.write` сейчас, в будущем — запись `brief.md`/`plan.md`/файлов кода), запись содержит относительный путь как кликабельную ссылку. Клик открывает файл редактором VS Code (через IPC из webview → `vscode.commands.executeCommand('vscode.open', …)` на стороне extension).
- Webview подписан на новые записи `tools.jsonl` через те же IPC-события, что и на `chat.jsonl` (или через новое `runs.tool.appended` — финализируется при реализации).

Общее:

- Большие/конфиденциальные аргументы (`kb.write.body`) сворачиваются до превью; полный JSON — по клику.
- TC покрывают: продолжение диалога после `awaiting_human` приводит к новому `brief.md`; ссылка на созданный файл открывает его в редакторе; tool call с ошибкой видно в ленте с диагностикой.

## Implementation notes

- IPC: ввести (или расширить существующее) сообщение `runs.user.message` для отправки текста пользователем в любой момент рана. Маршрутизация на стороне extension: если статус `awaiting_user_input` — это ответ на `ask_user`; иначе — продолжение диалога (новый user-message → ре-вход в `runAgentLoop`). Контракт правится в [src/extension/features/run-management/messages.ts](src/extension/features/run-management/messages.ts) и зеркально в `src/webview/shared/runs/`.
- Resume-логика для роли уже есть (`registerProductResumer` в [src/extension/features/product-role/](src/extension/features/product-role/)). Дописать вход «продолжение по новому пользовательскому сообщению» — сейчас она поднимает ран только из `awaiting_user_input`.
- Открытие файлов из webview: новое IPC `editor.open { path }`, в extension стороне — `vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath))`. Path из `tools.jsonl` относительный — резолвится относительно workspace root.
- TC писать **до реализации**: TC-22 (продолжение диалога после `awaiting_human` → новый `brief.md`), TC-23 (клик по ссылке на файл из `kb.write` открывает редактор), TC-24 (упавший тул виден в ленте с сообщением ошибки).

## Outcome

Реализовано в одном бранче:

- IPC: новый [runs.user.message](src/extension/features/run-management/messages.ts) — единая точка отправки текста пользователем; маршрутизация по статусу в [wire.ts](src/extension/features/run-management/wire.ts) (answer на ask_user / continue диалога / append в chat.jsonl). Старый `runs.user.answer` снят без shim'а.
- Resume: введён [ResumeIntent](src/extension/shared/agent-loop/resume.ts) (`answer | continue`); `reconstructHistory` принимает intent, `RoleResumer`/`resumeRun` тоже. Продакт ([product-role/run.ts](src/extension/features/product-role/run.ts)) и smoke ([tool-loop-smoke/command.ts](src/extension/features/tool-loop-smoke/command.ts)) пишут разный resume-маркер для каждого intent.
- Broadcast tools: каждое событие `tools.jsonl` теперь идёт через [recordToolEvent](src/extension/features/run-management/broadcast.ts) (5 точек в [agent-loop/loop.ts](src/extension/shared/agent-loop/loop.ts)) → `runs.tool.appended` в webview.
- UI: [RunDetails.tsx](src/webview/features/run-list/ui/RunDetails.tsx) разнесён на `AskUserBanner` (visual-only) + постоянный `Composer` + `Timeline` (мердж chat+tools по timestamp) + `ToolEntry` с кликабельной ссылкой на файл (`kb.write.path` → `editor.open`). Store ([runs/store.ts](src/webview/shared/runs/store.ts)) хранит `selectedDetails: { meta, chat, tools }` и обрабатывает новый event.
- Открытие файлов: IPC `editor.open` с валидацией относительного пути (no `..`, no absolute) в [wire.ts](src/extension/features/run-management/wire.ts).
- E2E: [TC-22](tests/e2e/specs/tc-22-continue-dialog-after-awaiting-human.spec.ts) (continue → новый brief), [TC-23](tests/e2e/specs/tc-23-tool-link-opens-file.spec.ts) (file link открывает editor), [TC-24](tests/e2e/specs/tc-24-failed-tool-visible-in-timeline.spec.ts) (упавший tool с error-text в ленте). DSL-фасад [agent.ts](tests/e2e/dsl/agent.ts) расширен: `sendUserMessage`, `openFileFromToolEntry`, `waitForToolEntry`.
- Lint: [eslint.config.mjs](eslint.config.mjs) теперь игнорит `.vscode-test/`, `playwright-report/`, `test-results/` (была OOM при сканировании), отдельный конфиг для CommonJS test-extension.

## Related

- US-10, US-11.
- Зависит от: #0001 (tool runtime + `tools.jsonl`), #0003 (продакт уже использует resume).
- Блокирует/упрощает: #0004 (архитектор отрисовывается в той же ленте), #0009 (кнопка «Достаточно вопросов» естественно живёт рядом с этим полем ввода).
- Связан: #0008 (длинные итеративные диалоги быстро упираются в лимит контекста — без компактификации US-10 быстро ломается на больших ранах).
