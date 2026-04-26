# TC-35. Канвас — handoff продакт→архитектор рисует ребро

US-24 (#0023). После того, как продакт сдал бриф и архитектор автоматически стартовал (#0004), на канвасе должно быть **два кубика** — `product` и `architect` — и **одно ребро** `product->architect` с подписью «бриф».

Этот TC ловит самые опасные регрессии foundation:

- если `SessionSummary.participants` перестанет уезжать в webview (исчезнет из `toSummary` или из IPC) — на канвасе исчезнет архитектор, останется только продакт;
- если `layoutCanvas` сломается на вычислении приёмника handoff'а (например, неправильно вычтет родителя из participants bridge'а) — ребро либо не появится, либо пойдёт в обратную сторону;
- если убрать пометку артефакта (briefPath / planPath) — подпись «бриф» на ребре пропадёт.

## Шаги

1. Подготовить fake-сценарий handoff'а: title → продактовый kb.list → brief → архитекторский kb.list → plan (как в TC-31), включить `AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=1`.
2. Создать ран, дождаться `plan.md` и статуса `awaiting_human` (значит handoff случился, bridge-сессия создана с обоими participants).
3. Открыть webview, выбрать ран. Дефолтная вкладка — «Карта».
4. Проверить, что:
   - в DOM есть `[data-canvas-role="product"]` и `[data-canvas-role="architect"]`;
   - есть ровно одно `[data-canvas-edge="product->architect"][data-canvas-edge-kind="handoff"]`;
   - подпись на ребре содержит «бриф»;
   - нет ребра `[data-canvas-edge="user->architect"]` (юзер в bridge не вмешивался).

## Ожидание

Канвас отражает структуру `meta.sessions`: каждой роли — кубик, каждому handoff'у — стрелка в правильную сторону.

## Связи

- US-24 (acceptance: «между участниками рисуются связи: handoff … стрелка от роли-источника к роли-приёмнику с пометкой "передал бриф"»).
- Issue #0023.
- Зависит от sсenario'я TC-31 (handoff happy path).
