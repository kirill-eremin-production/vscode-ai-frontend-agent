---
id: 0040
title: Resumer — history slicing для участников по participant_joined
status: done
created: 2026-04-26
---

## Context

Когда роль добавлена в сессию через `pullIntoRoom` (#0036) и VS Code перезапускается, резумер должен подать новому участнику корректный контекст: сообщения **с момента его входа**, а всё, что было раньше, — как «история до тебя» (всё ещё видимо в чате, но в LLM-контекст агента кладётся отдельно с пометкой «контекст до твоего прихода»).

## Acceptance criteria

- При построении LLM-контекста сессии для конкретной роли:
  - Если в журнале сессии есть `participant_joined {role: X, at: T}` — для роли X сообщения до `T` идут как блок «контекст до твоего прихода» (system-message с заголовком), сообщения с `T` — как обычная история.
  - Для ролей, которые были `participants` с создания сессии (нет `participant_joined` для них) — вся история без разделения.
- Резумер при подъёме сессии после рестарта расширения корректно восстанавливает это разделение из журнала.
- Unit:
  - Сессия: 5 сообщений → `participant_joined {role: programmer, at: T3}` → 3 сообщения. Контекст для programmer: block(msg1..msg2) + system-marker + msg3..msg5+joined+next3. Контекст для product (был с начала): все 8 + событие.
  - Идемпотентность при повторной активации.
- Без изменений в UI чата (рендер событий — в #0041).

## Implementation notes

- Если контекст-сборка живёт в `src/extension/entities/run/session/context.ts` (или подобном) — менять там.
- Точная формулировка system-marker — на русском, например: «Тебя только что добавили в эту сессию. Выше — история чата до твоего прихода. Отвечай по последнему сообщению».
- Не путать «контекст для LLM» с «что показано в UI» — UI всегда показывает всю историю, разделение только в промпте к модели.

## Related

- Подзадача #0030.
- Зависит от: #0036.

## Outcome

- `reconstructHistory` ([src/extension/shared/agent-loop/resume.ts](../src/extension/shared/agent-loop/resume.ts)) учитывает `config.role`: при наличии `participant_joined` для этой роли формирует `[system, user, pre-блок, system-маркер, ...post-события, intent-хвост]`, иначе работает как раньше.
- Покрытие: новая unit-сюита `reconstructHistory — slicing по participant_joined (#0040)` в [resume.test.ts](../src/extension/shared/agent-loop/resume.test.ts), US-40 в [tests/user-stories.md](../tests/user-stories.md), ручной [TC-47](../tests/e2e/specs/tc-47-resumer-history-slicing.md). Lint + build + test:unit зелёные (201/201).
- Реализация: коммит 15fe6e8.
