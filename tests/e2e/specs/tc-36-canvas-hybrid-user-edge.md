# TC-36. Канвас — hybrid: появляется кубик user и ребро user→архитектор

US-24 + #0012. Когда пользователь вмешивается в bridge-сессию между продактом и архитектором (TC-32 паттерн), bridge становится hybrid: его `participants` дополняется `{kind:'user'}`. Канвас должен это отразить:

- появляется отдельный кубик `[data-canvas-role="user"]`;
- появляется dashed-ребро `[data-canvas-edge="user->architect"][data-canvas-edge-kind="user"]` с подписью «вмешательство»;
- handoff-ребро `product->architect` остаётся на месте — hybrid не отменяет передачу.

Эта проверка ловит:

- если `layoutCanvas` перестанет добавлять user-узел при `hasUserParticipant` — пропадёт кубик и ребро;
- если перестанет различаться `kind: 'handoff' | 'user'` — UI не сможет нарисовать пунктир/подпись правильно;
- если participants bridge'а не обновляется на extension-стороне после user-message в `awaiting_human` — невозможно будет отличить чисто agent-agent ран от hybrid'а.

## Шаги

1. Поднять окружение TC-32: scenario с двумя версиями плана (PLAN_V1 → user-followup → PLAN_V2), `AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=1`.
2. Создать ран, дождаться `plan.md` и `awaiting_human`.
3. Открыть webview, выбрать ран, проверить, что на канвасе **до интервенции** нет user-узла и нет user-ребра (только product, architect и handoff-ребро).
4. Не выходя из канваса, вызвать `agent.sendUserMessage(USER_FOLLOWUP)`. Composer не зависит от вкладки и работает поверх обеих.
5. Дождаться обновления `plan.md` до v2 (сигнал, что bridge стал hybrid и архитектор отработал continue-цикл).
6. Проверить, что на канвасе теперь:
   - есть `[data-canvas-role="user"]`;
   - есть `[data-canvas-edge="user->architect"][data-canvas-edge-kind="user"]`;
   - handoff-ребро `product->architect` всё ещё на месте.

## Ожидание

Канвас в реальном времени переключается с agent-agent в hybrid-вид; user-стрелка отображается отдельно от handoff-стрелки.

## Связи

- US-24 (acceptance: «между участниками рисуются связи»; см. также US-26 о user-вмешательстве).
- Issue #0023.
- Зависит от инвариантов TC-32 (hybrid).
