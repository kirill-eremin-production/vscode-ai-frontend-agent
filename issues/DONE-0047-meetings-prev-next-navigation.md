---
id: 0047
title: Карточка встречи — prev/next ссылки и навигация
status: done
created: 2026-04-26
---

## Context

Карточки встреч (#0046) уже есть; теперь добавляем причинно-следственную связь между ними через `prev[]`/`next[]` (#0035).

## Acceptance criteria

- В каждой карточке встречи:
  - Если `prev.length > 0` — компактная строка «← откуда: <participants prev-сессии или короткий лейбл>» (по одному элементу на каждый `prev`).
  - Если `next.length > 0` — «→ что родилось: <participants next-сессии>» (по одному элементу на каждый `next`).
- Клик по prev/next-ссылке → скроллит панель к соответствующей карточке + подсвечивает её на ~1.5s (visual flash).
- Если соответствующая сессия в текущем ране отсутствует (orphan) — ссылка disabled с tooltip «сессия не найдена».
- Лейбл сессии для ссылки: иконки `participants` без имён (компактно). Hover → tooltip с временем + первым сообщением.
- Unit на функцию `summarizeSessionForLink(session): {icons: Role[], tooltip: string}`.

## Implementation notes

- Не открывать новые табы — навигация только внутри панели.
- Скролл к карточке — `scrollIntoView({block: 'center', behavior: 'smooth'})`.

## Related

- Подзадача #0029.
- Зависит от: #0035, #0046.

## Outcome

Реализовано в коммите 17a7047. В каждой карточке журнала встреч
появились компактные строки `← откуда:` / `→ что родилось:` по
элементу на каждый id из `prev[]`/`next[]` (#0035): лейбл — иконки
участников целевой сессии без подписей, hover → tooltip
`HH:MM · первое сообщение` (для просматриваемой) либо только время
(для остальных — chat-лента в store одна на ран). Клик по ссылке
делает `scrollIntoView({block:'center', behavior:'smooth'})` к
карточке-цели и подсвечивает её визуальным flash'ем на 1500мс через
outline; чат-таб не открывается. Orphan-сессии (id из prev/next, не
найденные в текущем ране) рендерятся disabled с tooltip'ом «сессия
не найдена».

Ключевые файлы:

- `src/webview/features/meetings/lib/format.ts` — `summarizeSessionForLink`,
  `getFirstMessageText` + 6 unit-тестов.
- `src/webview/features/meetings/ui/MeetingCard.tsx` — корневой
  `<button>` заменён на `<div role="button">` ради вложенных
  prev/next-кнопок; `SessionLinkRow`/`SessionLink`, flash через
  outline, callback-ref `onCardElement`.
- `src/webview/features/meetings/ui/MeetingsPanel.tsx` —
  `sessionsById`, реестр DOM-карточек через ref,
  `handleNavigateLink` со scroll+flash и одним общим таймером.
- `tests/user-stories.md` — US-46.
- `tests/e2e/specs/tc-54-meetings-prev-next-navigation.md` — TC-54.

Ревью замечаний не нашло: AC покрыты построчно, lint/build/test:unit
зелёные (260 unit-тестов).
