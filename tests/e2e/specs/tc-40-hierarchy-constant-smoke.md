# TC-40. hierarchy-константа: один источник правды по ролям — #0033

Задача чисто инфраструктурная: модуль `src/extension/team/hierarchy.ts`
не имеет прямого UI-эффекта. Этот TC ручной и сводится к тому, чтобы
убедиться: модуль реально единственный источник порядка ролей и его
импорт работает из любого места extension'а.

## Шаги

1. `nvm use && npm run lint && npm run build && npm run test:unit`.
2. Запустить расширение из VS Code (F5) на тестовом workspace.
3. Создать ран и довести его до состояния, в котором канвас рендерится
   (после #0042 порядок кубиков должен соответствовать `HIERARCHY`,
   но в рамках #0033 этой проверки делать не нужно — она появится
   вместе с реализацией #0042).
4. В исходниках сделать `grep -rn "'product'.*'architect'.*'programmer'" src/extension`.

## Ожидание

- Lint, build, unit-тесты — зелёные. В выводе `npm run test:unit`
  присутствует сюита `HIERARCHY / levelOf / rolesBetween / areAdjacent`.
- Расширение поднимается без runtime-ошибок при загрузке модуля
  (нет `Cannot find module './team/hierarchy'` и подобного).
- `grep` показывает упоминание тройки только в:
  - `src/extension/team/hierarchy.ts` (определение константы),
  - `src/extension/team/hierarchy.test.ts` (фиксация порядка теста),
  - `src/extension/entities/knowledge/schema.ts` (тип `KnowledgeRole`,
    т.к. `Role = KnowledgeRole`; параллельный enum имён ролей не
    создан).
- Любого другого файла с дублирующимся литералом порядка ролей нет —
  если появится, это сигнал, что hierarchy-модуль не подключили там,
  где должны были.
