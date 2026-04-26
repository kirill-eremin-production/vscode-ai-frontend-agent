---
id: 0013
title: Ручная компактификация контекста с созданием новой сессии
status: open
created: 2026-04-26
---

## Context

#0008 (Phase 1) завозит storage-схему `sessions/<sid>/` и индикатор заполненности контекста, но саму компактификацию не делает: кнопка «Сжать контекст» в карточке рана видна, но `disabled` с tooltip «доступно после #0013».

Эта задача добавляет реальную логику: жмём «Сжать» → модель сводит текущую сессию в summary → создаётся новая сессия с этим summary как стартовым контекстом → старая остаётся на диске read-only, доступной через табы.

## Acceptance criteria

- Кнопка «Сжать контекст» становится активна, когда текущая сессия в `running` / `awaiting_human` / `awaiting_user_input` (запрещаем только `draft` и `compacting` в процессе).
- Перед запуском — confirm-диалог React-модалкой (overlay + два действия: «Сжать» / «Отмена»). Native `vscode.window.showWarningMessage` не используем — webview-модалка консистентнее.
- Компактификация:
  - вызывает модель `COMPACTOR_MODEL` (по умолчанию = `PRODUCT_MODEL`, литерал в `src/extension/shared/agent-loop/compaction.ts`) с инструкцией свести `chat.jsonl` + `tools.jsonl` текущей сессии в короткое summary (≤ 1500 токенов, основные решения, открытые вопросы, ссылки на kb-артефакты);
  - создаёт новую сессию `sessions/<new-sid>/` с `kind: 'user-agent'`, `parentSessionId = old-sid`;
  - в `chat.jsonl` новой сессии первая запись — `from: 'agent:system'` с текстом «Контекст сжат. Резюме:\n\n<summary>»;
  - в `loop.json` новой сессии `userMessage = <summary>` (модель видит его как точку входа при следующем resume);
  - старая сессия получает статус `compacted` (новый, добавляется в `RunStatus`);
  - `runs/<id>/meta.json` обновляется: `activeSessionId = new-sid`, добавляется новая запись в `sessions[]`;
  - usage за компактификацию (input + output токены summary-вызова) аккумулируется в новой сессии и в run-aggregate.
- IPC: новый `runs.session.compact { runId }`, broadcast `runs.session.created { runId, session }`. После compact extension шлёт `runs.updated` (active изменилась) — UI переключается на новую сессию автоматически.
- В UI: под табом старой сессии бейдж «compacted», composer disabled, баннер «Эта сессия закрыта compact'ом, активная — Session N». Реактивация старой сессии — отдельная задача (#0012).
- Бэкап: `chat.jsonl` старой сессии **не** трогаем (он же остаётся в `sessions/<old-sid>/`); никакого `.bak`-файла рядом не плодим.
- TC-26 (новый): сценарий с 3 шагами → жмём compact → проверяем, что (а) новая сессия создана с summary как первое сообщение, (б) старая помечена `compacted`, (в) total usage = sum(old + summary call), (г) активная сессия в `meta.json` — новая.

## Implementation notes

- `compactSession(context, runId, sessionId)` — отдельный модуль `src/extension/shared/agent-loop/compaction.ts`. Не интегрируется в `runAgentLoop` — это явная одноразовая операция, дёргается из IPC-handler'а, а не из цикла.
- Summary-prompt держим литералом в том же файле; при будущей доработке (выбор модели, формат summary) — менять в одном месте.
- Подача summary в loop при resume: `userMessage` новой сессии = summary, `initialHistory` пересобирается обычным путём через `reconstructHistory`. Никакого спец-кейса в `runAgentLoop` не нужно — для него новая сессия выглядит как обычный новый ран.
- React-модалка: `src/webview/shared/ui/ConfirmModal.tsx`, минимальная (overlay + два callback'а).

## Related

- Зависит от: #0008 Phase 1 (sessions storage layout, pricing, context indicator).
- Связан: #0012 (после ремоделирования сессий в дерево + редактирования истории старые сессии станут реактивируемыми).
