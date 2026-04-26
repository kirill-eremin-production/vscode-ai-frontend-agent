---
id: 0012
title: Мульти-агентский режим (agent-agent сессии и дерево сессий)
status: done
created: 2026-04-26
completed: 2026-04-26
---

## Outcome

- `SessionKind` уже включал `agent-agent` (#0008), `Participant`-структура — тоже. Остался только мост.
- Handoff `runProduct → runArchitect` теперь создаёт **новую сессию** `kind: 'agent-agent'`, `participants: [agent:product, agent:architect]`, `parentSessionId` = продактовая сессия. Активной становится bridge — туда уходит весь дальнейший вывод архитектора. См. [product-role/run.ts](../src/extension/features/product-role/run.ts) (success-ветка `finalizeRun`). Бриф-превью кладётся первым сообщением bridge от `agent:product` — сидит её как «вот с чем продакт передал работу».
- Архитектор сам по себе не правился — все его append'ы идут через `meta.activeSessionId`, который теперь bridge.
- Hybrid: первое user-сообщение в любой сессии добавляет `{kind:'user'}` в её `participants` через новый storage-helper [`addParticipant`](../src/extension/entities/run/storage.ts) (идемпотентно, изменения broadcast'ятся `runs.updated`). Логика — в [wire.ts:ensureUserParticipant](../src/extension/features/run-management/wire.ts) на обоих путях user-input (continue + finalize).
- Дерево сессий в UI ([RunDetails.tsx](../src/webview/features/run-list/ui/RunDetails.tsx)): `SessionTabs` строится из `parentSessionId` через `buildSessionTree` (рекурсивно) и рендерится отступом по глубине. Корни сортируются по `createdAt`. Bridge помечается «🤝 Передача», ● маркирует живую сессию.
- Composer: в активной (живой) сессии работает как раньше (continue/answer/finalize). В неактивной (просмотр истории через клик по табу) — read-only с подсказкой «вернитесь в активную сессию, чтобы продолжить».
- Per-session sessionId в broadcast'ах: `runs.message.appended` и `runs.tool.appended` теперь несут `sessionId`. `appendChatMessage`/`appendToolEvent` возвращают фактический sessionId, callers передают его в broadcast. Webview store фильтрует live-приращения: применяются только для просматриваемой сессии (явный selectedSessionId или активная при follow-mode), чужие — игнорируются. При смене активной сессии в follow-mode (handoff) автоматически вызывается `runs.get` для нового активного.
- IPC `runs.get` принимает опциональный `sessionId`; ответ эхо-возвращает реально прочитанную сессию. `getRunDetails` параметризован, чтобы UI клика по неактивному табу мог получать его историю без переключения активной.
- E2E: TC-31 расширен под bridge-сессию (две сессии в meta, `parentSessionId`, разделение чата по сессиям, tool-события считаются по обеим сессиям). Новый [TC-32 (`tc-32-multi-agent-hybrid.spec.ts`)](../tests/e2e/specs/tc-32-multi-agent-hybrid.spec.ts) — happy-path hybrid: продакт → handoff → архитектор → user-followup в bridge → continue-цикл архитектора → `plan_v2` → проверка `participants += user`, чужая сессия не получила user-сообщение.

## Context

После #0008 ран — это набор сессий (chat threads) с одним общим продуктом работы (brief, kb-файлы — после #0011). Сейчас сессии создаются только compact'ом, и существуют только `kind: 'user-agent'`.

После #0004 в системе появляется вторая роль (архитектор), которая стартует автоматически после продакта и читает `brief.md`. На первой итерации связь между ролями — через артефакты в kb (продакт пишет brief, архитектор читает). Эта задача добавляет **прямой канал общения между агентами**: сессию `kind: 'agent-agent'`, в которой роли обмениваются сообщениями, а пользователь может вмешаться.

Редактируемая история (изначально часть этого issue) вынесена в отдельный #0014 — она ортогональна мульти-агенту и может идти параллельно.

## Acceptance criteria

- Сессия `kind: 'agent-agent'` помимо существующего `'user-agent'` (поле уже добавлено в #0008).
- `participants: [{kind:'agent', role:'product'}, {kind:'agent', role:'architect'}]` — структура из #0008 расширяется новой комбинацией.
- Когда роль решает «передать работу следующей роли» — extension создаёт новую `agent-agent` сессию, сидит её первым сообщением (например, brief как `from: 'agent:product'`) и запускает agent-loop принимающей роли поверх этого сообщения.
- В UI вкладок (введён в #0008) такие сессии видны вперемешку с пользовательскими; иконка/бейдж отличает по `kind`.
- Пользователь может в любой момент написать в `agent-agent` сессию — это превращает её в hybrid (`participants` дополняется `{kind:'user'}`), оба агента продолжают видеть ввод как часть истории.
- Дерево сессий: `runs/<id>/meta.json.sessions[]` обогащается полем `parentSessionId` (уже есть для compact-сценария) + `kind`. UI рисует tree (родитель → дети), а не плоский список вкладок.
- Routing завершения: когда архитектор финализируется в agent-agent сессии, его `plan.md` ложится в kb (по аналогии с brief #0011), `RunMeta.planPath` хранит ссылку. Если затем подключается следующая роль — снова новая agent-agent сессия с `plan.md` как первым сообщением.

## Implementation notes

- Сессии-мост переиспользуют `runAgentLoop`: `userMessage` — это сообщение от соседнего агента (полный текст brief'а / plan'а), `tools` — реестр принимающей роли, `systemPrompt` — её system prompt. Никакого нового агентского рантайма.
- Финальный assistant-ответ принимающей роли пишется в `chat.jsonl` сессии-моста (не в основной чат рана), и параллельно — в kb через `writePlan`/`writeBrief`-аналог.
- Дерево сессий в UI: первая (initial) сессия — корень; agent-agent сессии — её дети (или дети предыдущей agent-agent сессии в цепочке). Compact (#0013) создаёт sibling — сестру компактнутой. Достаточно простой 2-уровневой иерархии без полной generic tree-структуры.
- User-intervention в agent-agent сессии: композер не disabled. Отправка превращает сессию в hybrid, в `participants` добавляется `{kind:'user'}` (если ещё не там), сообщение приходит обоим агентам в следующий шаг loop'а как часть истории.
- TC: TC-XX мульти-агент happy path (продакт → архитектор через agent-agent сессию, brief → plan), TC-XX user-intervention в agent-agent сессии корректно влияет на следующий шаг архитектора, TC-XX дерево сессий отображается в UI с правильным parent-child.

## Related

- Зависит от: #0008 (sessions), #0011 (общие артефакты в kb), #0004 (вторая роль — архитектор).
- Связан: #0014 (редактируемая история — ортогонально), #0013 (compact — другой источник создания сессий).
