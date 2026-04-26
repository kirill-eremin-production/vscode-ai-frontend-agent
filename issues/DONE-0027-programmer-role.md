---
id: 0027
title: Реализовать роль программиста (plan.md → реальные правки в коде проекта)
status: done
created: 2026-04-26
---

## Outcome

Цикл «идея → бриф → план → код» замкнут. Программист добавлен как третья роль и автостартует после успеха архитектора.

- Роль и handoff: `src/extension/entities/run/roles/programmer.{ts,prompt.ts}`, `src/extension/entities/knowledge/programmer-readme.ts`. Включена в `KNOWLEDGE_SCHEMA` ([schema.ts](src/extension/entities/knowledge/schema.ts), [index.ts](src/extension/entities/knowledge/index.ts)). Fire-and-forget из success-ветки `runArchitect` ([architect-role/run.ts](src/extension/features/architect-role/run.ts)).
- Workspace fs-тулы (первый раз агент трогает реальный код пользователя): [workspace-fs-tools.ts](src/extension/features/programmer-role/workspace-fs-tools.ts) с unit-покрытием в [workspace-fs-tools.test.ts](src/extension/features/programmer-role/workspace-fs-tools.test.ts). Sandbox = workspaceRoot, double-realpath check, deny-write список (`.agents/`, `.git/`, `node_modules/`, и пр.). Без `fs.delete`/`fs.rename` намеренно.
- Артефакты: `summary.md` пишется через [storage.ts](src/extension/entities/run/storage.ts), `RunMeta.summaryPath` отдаётся в UI ([RunDetails.tsx](src/webview/app/shell/RunDetails.tsx)).
- Resumer: программист регистрируется в `activate` ([extension/index.ts](src/extension/index.ts)).
- E2E: TC-40/41/42 покрывают happy path, sandbox containment, resumer (через `extraEnv`-фикстуру в [tests/e2e/fixtures/vscode.ts](tests/e2e/fixtures/vscode.ts) и DSL [run-artifacts.ts](tests/e2e/dsl/run-artifacts.ts)).
- Намеренно вне scope: shell-тулы, per-write approval, `fs.delete/rename`, декомпозиция плана — записаны в Related как будущие задачи.

## Context

Сейчас цепочка обрывается на архитекторе: продакт пишет `brief.md` → архитектор пишет `plan.md` → дальше тишина. До этого момента вся ценность системы — обещанная, а не реальная: я не могу честно сказать себе, нравится ли мне как пользователю работать через AI Frontend Agent, потому что замкнутого цикла нет.

Цель этой итерации — **грубо** замкнуть цикл «идея → бриф → план → код в моём проекте». Качество реализации программиста на первой итерации намеренно ограничивается: одна роль, минимум тулов, никакой умной декомпозиции, никаких approve/reject между подзадачами. Главное — чтобы по итогу рана в рабочей копии проекта появились настоящие правки, которые можно посмотреть через `git diff`.

Это первая роль, у которой есть доступ к коду пользовательского проекта. До этого все агенты работали только в `.agents/knowledge/` (изолированный sandbox kb). Программисту нужны fs-тулы поверх workspace — это самое существенное архитектурное расширение задачи.

## Acceptance criteria

**Роль и handoff:**

- Новая роль `programmer` в `KNOWLEDGE_SCHEMA`. Файлы по конвенции: `src/extension/features/programmer-role/{index.ts,run.ts}`, `src/extension/entities/run/roles/programmer.{ts,prompt.ts}`.
- Программист стартует автоматически после успеха архитектора по той же схеме, что архитектор после продакта (fire-and-forget из success-ветки `runArchitect`). Approve/reject между ролями — отдельная будущая задача.
- На вход программисту в первом user-message — полный текст `plan.md` (как architect получает brief). Парсинг подзадач не делаем; модель сама решает, в каком порядке идти.
- Resumer регистрируется в `activate` — ран программиста с pending `ask_user` поднимается после рестарта VS Code (как у других ролей).

**Модель:**

- Сильная code-модель (например, `anthropic/claude-sonnet-4-6` через OpenRouter). Имя константой в `roles/programmer.ts`, pricing/context-limit рядом.
- Лимит итераций agent-loop: можно поднять выше дефолтных 20, потому что реализация подзадач длиннее, чем написание брифа/плана. Финализировать при реализации; верхняя граница в любом случае жёсткая (anti-runaway).

**Тулы — два класса:**

1. **kb-тулы** программиста (как у других ролей): `kb.read`, `kb.write`, `kb.list`, `kb.grep` через `buildRoleScopedKbTools('programmer')`. Sandbox — `.agents/knowledge/programmer/`. Структура kb:
   - `patterns/` — конвенции реализации, обнаруженные в кодовой базе (как пишем тесты, как структурируем фичи).
   - `decisions/` — реализационные решения, сделанные в прошлых ранах.
   - `gotchas/` — грабли, на которые наступал (флаки тесты, странности тулинга, обходные пути).
   - `README.md` — описание схемы (по образцу `architect-readme.ts`).
2. **Новые fs-тулы** поверх workspace проекта пользователя: `fs.read`, `fs.write`, `fs.list`, `fs.grep`. Это **первый раз**, когда агент трогает реальный код пользователя — поэтому сделать аккуратно:
   - Sandbox — корень workspace (`vscode.workspace.workspaceFolders[0]`). Любой путь нормализуется и проверяется на побег за пределы (`..`, абсолютные пути, симлинки наружу).
   - Чёрный список: `.agents/`, `.git/`, `node_modules/`, `out/`, `dist/`, `.vscode/`, `*.lock`, `*.log` — чтение разрешено, запись запрещена. Точный список — литералом в коде, единая константа.
   - `fs.write` — атомарная запись (через temp + rename), как у `writeBrief`/`writePlan` в storage.
   - `fs.write` логируется в `tools.jsonl` с относительным путём и размером записанного — чтобы я мог по логу восстановить, что натворил агент.
   - **Никакого** `fs.delete` / `fs.rename` на этой итерации. Удалять и переименовывать файлы пользователю агент не имеет права. Это намеренно — снижаем blast radius первой итерации.

**Артефакты рана:**

- Реальные правки в `src/...` (или где там у пользователя код) — это и есть основной артефакт. Не архивируем, не копируем — они живут как обычные изменения в рабочей копии, видны через `git status` / `git diff`.
- `summary.md` — короткий отчёт программиста: какие файлы тронул, что в них изменилось концептуально (1–2 строки на файл), какие подзадачи плана выполнены, какие нет (и почему), известные ограничения. Сохраняется в `.agents/knowledge/programmer/summaries/<runId>-<slug>.md` (по образцу `brief.md`/`plan.md`). Ссылка хранится в `RunMeta.summaryPath`. Writer — в `storage.ts`.
- В UI секция `RunDetails` показывает три артефакта подряд: «Бриф» → «План» → «Сводка изменений».

**System prompt программиста описывает:**

- Что роль — реализатор плана, не архитектор и не критик. Если план кажется неполным/противоречивым — `ask_user`, не «исправляем сами по ходу».
- Обязательный паттерн: на старте — `kb.list` своей kb (patterns/decisions/gotchas), `fs.list` корня проекта, `fs.read` ключевых конфигов (`package.json`, `tsconfig.json`, README) → понять стек → потом план реализации первой подзадачи.
- При неоднозначности конвенций кода — сначала `fs.grep` по существующему коду, чтобы найти, как делается рядом, **потом** писать. Запрет «писать с нуля по своим вкусам, когда в проекте уже есть устоявшийся способ».
- Запись в kb: новые `patterns/` и `gotchas/` — после реализации, если узнал что-то нетривиальное про этот проект.
- Финал: после реализации (или когда упёрся) — `summary.md` через специальный writer.

**Статусы:** `awaiting_human` (после архитектора) → `running` (программист) → `awaiting_user_input` на `ask_user` → `awaiting_human` (правки в коде + summary готовы) | `failed`.

**Ошибки:** нет `plan.md`, сетевой сбой, превышен лимит итераций, попытка записи в чёрный список, попытка побега из workspace — `failed` с диагностикой в логе. Побег из sandbox — это не «agent сделал ошибку», это «есть баг в sandbox»; такие случаи отдельно помечаются в `tools.jsonl` уровнем `error` для последующего анализа.

**Тесты — писать ДО реализации:**

- TC-40 (programmer happy path): полная цепочка продакт → архитектор → программист на простой задаче типа «добавь функцию `formatDate(d)` в новый файл `src/utils/date.ts` и unit-test к ней». В конце: файл существует, тест проходит, `summary.md` есть, `RunDetails` показывает все три артефакта.
- TC-41 (sandbox containment): попытка `fs.write` в `../etc/passwd`, в `.git/HEAD`, в абсолютный путь вне workspace, в `node_modules/foo/bar` — все отвергаются с понятной ошибкой; ран не падает, агент получает tool-result с ошибкой и может попробовать другой путь.
- TC-42 (resumer): программист задал `ask_user`, VS Code перезапустили — ран поднимается, ответ пользователя продолжает выполнение.
- E2E фикстура `extraEnv` уже есть (#0004) — переиспользуем для `AI_FRONTEND_AGENT_AUTOSTART_PROGRAMMER=0/1`, чтобы старые TC не ломались о новый автозапуск.

## Implementation notes

- `runProgrammer({runId, apiKey})` живёт в `src/extension/features/programmer-role/run.ts`. Из success-ветки `runArchitect` — fire-and-forget вызов.
- Новый sandbox `buildWorkspaceFsTools(workspaceRoot, {denyWrite: [...]})` — отдельный модуль в `src/extension/features/programmer-role/workspace-fs-tools.ts`, **не** в shared. Если потом архитектор/продакт получат readonly fs-доступ — общую часть выделим тогда. Сейчас не угадываем.
- Path safety — единственное место, где может пойти что-то страшное. Минимум: `path.resolve(root, requested)` → проверка startsWith(`root + sep`) → `fs.realpath` → повторная проверка startsWith. Симлинк-побег закрывается именно вторым.
- `fs.grep` — обёртка над `ripgrep`, если он есть в системе (есть на маках, в Dev Container — не всегда), иначе — fallback на JS-реализацию через `vscode.workspace.findFiles` + чтение. Финализировать при реализации; не делать сложный детект, если простой работает.
- На первой итерации **не** выполняем команд (`npm test`, `tsc --noEmit`) от лица агента. Это огромное расширение blast radius (произвольное выполнение кода) и оно не нужно для грубого замыкания цикла. Программист пишет код «вслепую», пользователь сам проверяет результат через свой обычный workflow. Тулы для запуска команд — отдельная задача (#NNNN-programmer-shell).
- Не делаем подтверждение каждой правки человеком в этой итерации. Цикл approve-per-write — отдельная задача. Пока полагаемся на (а) sandbox по workspace, (б) git как safety net, (в) summary.md для постфактум-ревью.
- Canvas (#0023..#0026): третий кубик роли в графе — `programmer`. Стрелка architect→programmer — ещё одна handoff-сессия (`agent-agent`, participants: architect+programmer). Drill-resolver уже умеет owner-based матчинг — должен заработать без изменений; проверить отдельным unit-тестом.

## Related

- US-? (нужно завести user-story «получить реальный код по идее за один ран» — сейчас её нет, добавить при подготовке).
- Зависит от: #0004 (архитектор + handoff-конвенция), #0001 (tool runtime), #0011 (artifacts in knowledge — конвенция хранения артефактов в общей kb).
- Связан: #0026 (canvas drill-in — добавить третий кубик и второе ребро), #0010 (universalisation — программист должен работать только если ран фичевый и архитектор произвёл `plan.md`; не-фичевые раны до программиста не доходят).
- Будущие задачи (намеренно вынесены за скоп):
  - approve/reject между ролями (architect→programmer, и per-subtask внутри программиста).
  - shell-тулы (запуск тестов и тайпчека от лица агента).
  - per-write подтверждение пользователем (interactive diff review).
  - декомпозиция плана и параллельные программисты по независимым подзадачам.
  - `fs.delete` / `fs.rename` (требуют отдельного обсуждения safety).
