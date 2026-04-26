import { describe, expect, it } from 'vitest';
import { buildProductSystemPrompt } from './product.prompt';
import { buildArchitectSystemPrompt } from './architect.prompt';
import { buildProgrammerSystemPrompt } from './programmer.prompt';

/**
 * Тесты раздела «Команда и эскалация» в системных промптах ролей (#0039).
 *
 * Промпты — статический контракт, видный модели и человеку. Если из
 * промпта пропадёт правило про invite/escalate, модель снова начнёт
 * собирать цепочку посредников вручную или дёргать продакта в обход
 * архитектора. Поэтому мы проверяем подстроки буквально — снапшот в
 * виде ключевых фраз. На объёме промпта это устойчивее «целого
 * snapshot'а»: переформулируем соседние блоки — тесты не ломаются;
 * пропадёт ключевое правило — ломаются.
 *
 * AC задачи #0039 распадается на четыре проверяемых инварианта,
 * по одному `describe` на каждый:
 *  1. Во всех трёх промптах есть раздел «Команда и эскалация» с
 *     описанием иерархии и правилом invite/escalate.
 *  2. Programmer-промпт содержит конкретный пример эскалации к продакту.
 *  3. Architect-промпт фиксирует, что invite соседей — норма, а escalate
 *     ему практически не нужен.
 *  4. Product-промпт фиксирует, что escalate(programmer) автоматически
 *     подтянет архитектора.
 */

describe('prompts.team_escalation: общий раздел во всех ролях', () => {
  const prompts = [
    { name: 'product', text: buildProductSystemPrompt() },
    { name: 'architect', text: buildArchitectSystemPrompt() },
    { name: 'programmer', text: buildProgrammerSystemPrompt() },
  ];

  it.each(prompts)('$name: содержит заголовок раздела «Команда и эскалация»', ({ text }) => {
    // Заголовок — единая зацепка, по которой человек найдёт раздел в
    // выводе модели и в исходнике, поэтому проверяем буквально.
    expect(text).toContain('## Команда и эскалация');
  });

  it.each(prompts)(
    '$name: фиксирует иерархию User → product → architect → programmer',
    ({ text }) => {
      // Порядок важен: roles `User → product → architect → programmer`
      // — это буквальный source of truth из #0033. Если кто-то поменяет
      // его на «product → architect → programmer → ...», unit подскажет.
      expect(text).toContain('User → product → architect → programmer');
    }
  );

  it.each(prompts)('$name: упоминает оба тула — team.invite и team.escalate', ({ text }) => {
    expect(text).toContain('team.invite');
    expect(text).toContain('team.escalate');
  });

  it.each(prompts)(
    '$name: содержит правило соседний уровень → invite, через уровень → escalate',
    ({ text }) => {
      // Это и есть soft-rule из задачи: явная подсказка модели, какой
      // тул когда применять.
      expect(text).toContain('соседний уровень');
      expect(text).toContain('через уровень');
    }
  );
});

describe('prompts.team_escalation: programmer-конкретика', () => {
  const promptText = buildProgrammerSystemPrompt();

  it('содержит явный пример эскалации к продакту через team.escalate', () => {
    // По AC: пример «programmer задаёт вопрос product → team.escalate('product', '...')».
    expect(promptText).toContain("team.escalate('product'");
  });

  it('фиксирует ожидаемый итоговый состав комнаты [programmer, architect, product]', () => {
    // Это критичная иллюстрация: модель должна понимать, что архитектор
    // окажется в комнате автоматически, без отдельного invite.
    expect(promptText).toContain('[programmer, architect, product]');
  });
});

describe('prompts.team_escalation: architect-конкретика', () => {
  const promptText = buildArchitectSystemPrompt();

  it('фиксирует, что invite соседей (product/programmer) — норма', () => {
    // Архитектор не должен «эскалировать» к соседу: оба соседа доступны
    // через invite. Подстрока должна явно это подсказывать.
    expect(promptText).toContain("team.invite('product' | 'programmer'");
  });

  it('фиксирует, что escalate архитектору почти не нужен', () => {
    // Архитектор находится посередине иерархии; «через уровень» от него
    // нет ни в одну сторону. Это явно указано в промпте.
    expect(promptText).toContain('практически не используешь');
  });
});

describe('prompts.team_escalation: product-конкретика', () => {
  const promptText = buildProductSystemPrompt();

  it("фиксирует, что team.escalate('programmer', ...) подтянет архитектора автоматически", () => {
    // По AC: явная подсказка продакту, что для прямого ответа
    // программиста используется escalate, а не ручной сбор цепочки.
    expect(promptText).toContain("team.escalate('programmer'");
  });
});
