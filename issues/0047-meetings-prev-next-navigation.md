---
id: 0047
title: Карточка встречи — prev/next ссылки и навигация
status: open
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
