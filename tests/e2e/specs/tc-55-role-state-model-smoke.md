# TC-55. role-state модель: idle/busy/awaiting_input — #0048

Задача чисто инфраструктурная: модуль
`src/extension/entities/run/role-state.ts` — pure-функция, не имеющая
своего UI-эффекта на этой итерации (UI индикаторы paused и inbox
появятся в #0052). Этот TC ручной и сводится к тому, чтобы убедиться:
функция реально подключилась в кодовую базу, импорт работает из
extension'а, юниты покрывают все ветки AC.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. Убедиться, что в выводе `npm run test:unit` присутствуют сюиты
   `roleStateFor` и `selectRoleStates` из
   `src/extension/entities/run/role-state.test.ts`.
3. В тестовом workspace запустить расширение из VS Code (F5). Создать
   ран обычным путём (US-2), довести его до состояния
   `awaiting_user_input` (продакт задал вопрос).
4. В DevTools extension host (Output → AI Frontend Agent / `Help →
Toggle Developer Tools` для extension host) убедиться, что нет
   runtime-ошибки `Cannot find module './role-state'` и подобных.
5. В исходниках сделать `grep -rn "roleStateFor" src/extension`.

## Ожидание

- Lint, build, unit-тесты — зелёные. Сюита `roleStateFor` содержит
  минимум:
  - `idle для всех ролей в пустом ране`,
  - `busy с id сессии, если последнее сообщение от другого участника`,
  - `idle, если последнее сообщение от самой роли (она уже ответила)`,
  - `awaiting_input при наличии pending meeting-request от этой роли`.
    Сюита `selectRoleStates` содержит проверку «возвращает запись по всем
    ролям иерархии».
- Расширение поднимается без ошибок загрузки модуля; сам модуль на этой
  итерации никем не вызывается из рантайма (это нормально — потребители
  появятся в #0050/#0051), но импорт типов `RoleState` из других мест
  не падает.
- `grep` показывает упоминания `roleStateFor` пока только в:
  - `src/extension/entities/run/role-state.ts` (определение),
  - `src/extension/entities/run/role-state.test.ts` (тесты).
    При появлении первого реального вызова в #0050/#0051 этот пункт
    устаревает — обновить TC синхронно.

## Известные ограничения

- На этой итерации `meetingRequests` всегда пустой массив: реальный
  storage добавит #0049, наполнит — #0050/#0051. Поэтому состояние
  `awaiting_input` в живом ране воспроизвести нельзя — только через
  unit-тест.
- UI-выход состояний (paused-кубик, inbox) — в #0052; здесь он не
  проверяется.
