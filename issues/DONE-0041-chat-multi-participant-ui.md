---
id: 0041
title: Chat UI — отображение N участников и цвета bubble по роли
status: done
created: 2026-04-26
---

## Context

После #0034 в сессии может быть >2 участников. Текущий чат-вью предполагает пару — нужно показать список участников и визуально различать сообщения по роли.

## Acceptance criteria

- В шапке чат-вью — горизонтальный список аватаров/иконок ролей по `session.participants`.
- При live-обновлении (новый `participant_joined`) — аватар появляется в шапке без перезагрузки.
- Каждый message-bubble получает визуальный маркер `authorRole`: цвет рамки/фона + аватар роли. Существующий цвет user-сообщения остаётся.
- Системное событие `participant_joined` рендерится отдельным компактным элементом в ленте: «→ <role> присоединился в HH:MM».
- Цвета ролей берутся из существующих токенов (см. `src/webview/styles/` или подобное), либо вводится новая палитра ролей одним коммитом — без переопределений по месту.
- Storybook (если используется): добавить story с сессией на 3 участников и событием `participant_joined` посередине.

## Implementation notes

- Не трогать логику отправки/приёма сообщений — только рендер.
- Не реализовывать pull-in-кнопку в UI (это будущее).

## Related

- Подзадача #0030.
- Зависит от: #0034, #0036.

## Outcome

Реализовано в коммите ee06f0f. Шапка чата (`ParticipantsHeader`) рисует
аватары `viewedSession.participants` и обновляется live через `runs.updated`;
bubble'ы получают левый бордер цвета роли через токены `--color-role-*`
(добавлен `programmer` → `--vscode-charts-orange`, иконка `Code`); событие
`participant_joined` рендерится отдельным `ParticipantJoinedRow`. Маппинг
ролей вынесен в `src/webview/features/chat/lib/roles.ts` (purely functional,
покрыт unit-тестами). Storybook-сторис `MultiParticipantChat`, US-41,
ручной TC-48. Ревью замечаний не нашло — lint/build/test:unit зелёные
(214/214).
