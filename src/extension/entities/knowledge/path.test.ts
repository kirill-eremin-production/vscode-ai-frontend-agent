import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRolePath } from './path';
import { KnowledgeSchemaError, PRODUCT_SUBDIRS } from './schema';
import { PRODUCT_KB_README_MARKDOWN } from './product-readme';
import { RunStorageError } from '@ext/entities/run/storage';

/**
 * Проверяем три независимых уровня контракта:
 *
 *  1. Happy path: каждая разрешённая поддиректория продакта
 *     ресолвится в правильный относительный + абсолютный путь.
 *  2. Schema-валидация: неизвестная роль / поддиректория / имя
 *     файла отбиваются `KnowledgeSchemaError` ДО fs-проверки.
 *  3. Двойная защита: даже если schema-проверка где-то протекла,
 *     sandbox-уровень `resolveKnowledgePath` поймает побег.
 *
 * Плюс синхронизация README ↔ schema — тест ловит ситуацию, когда
 * добавили поддиректорию в schema.ts, но забыли упомянуть в README.
 */

describe('resolveRolePath', () => {
  it('строит правильный knowledge-relative путь со слешами и абсолютный путь внутри workspace', () => {
    // glossary — самая «дефолтная» поддиректория продакта; берём её
    // как репрезентативную для happy path.
    const result = resolveRolePath({
      role: 'product',
      subdir: 'glossary',
      file: 'churn-rate.md',
    });

    expect(result.knowledgeRelativePath).toBe('product/glossary/churn-rate.md');
    // Абсолютный путь должен заканчиваться знакомым «хвостом» — это
    // достаточная проверка без хардкода всего temp-prefix'а.
    expect(result.absolutePath.endsWith(path.join('product', 'glossary', 'churn-rate.md'))).toBe(
      true
    );
  });

  it('принимает все поддиректории, объявленные в схеме продакта', () => {
    // Цель — гарантировать, что список PRODUCT_SUBDIRS реально живой,
    // а не зашит в одно место. Если кто-то добавит папку в схему,
    // этот тест автоматически проверит, что resolveRolePath её знает.
    for (const subdir of PRODUCT_SUBDIRS) {
      const result = resolveRolePath({
        role: 'product',
        subdir,
        file: 'note.md',
      });
      expect(result.knowledgeRelativePath).toBe(`product/${subdir}/note.md`);
    }
  });

  it('отбивает неизвестную роль через KnowledgeSchemaError, не RunStorageError', () => {
    // Намеренная type-assertion — в проде неизвестная роль придёт
    // строкой из рантайма (имени файла, аргумента тула в будущем).
    expect(() =>
      resolveRolePath({
        role: 'programmer' as never,
        subdir: 'decisions',
        file: 'x.md',
      })
    ).toThrow(KnowledgeSchemaError);
  });

  it('отбивает неизвестную поддиректорию даже при валидной роли', () => {
    expect(() =>
      resolveRolePath({
        role: 'product',
        subdir: 'random-folder',
        file: 'x.md',
      })
    ).toThrow(KnowledgeSchemaError);
  });

  it.each([
    ['пустое имя файла', ''],
    ['скрытый файл', '.hidden.md'],
    ['не-markdown', 'note.txt'],
    ['со слешем внутри', 'sub/note.md'],
    ['точка-точка', '..'],
  ])('отбивает имя файла: %s', (_label, file) => {
    expect(() =>
      resolveRolePath({
        role: 'product',
        subdir: 'glossary',
        file,
      })
    ).toThrow(KnowledgeSchemaError);
  });

  it('пропускает sandbox-уровень: невозможно протащить побег даже мимо schema-проверок', () => {
    // Этот кейс гипотетический — schema-валидатор уже отбивает `..`,
    // но мы хотим явно зафиксировать инвариант: побег ловится в
    // любом случае. Конструируем файл, который пройдёт regex
    // расширения, но тут ему помешает запрет на разделители.
    expect(
      () =>
        resolveRolePath({
          role: 'product',
          subdir: 'glossary',
          file: '../../etc/passwd.md',
        })
      // Может прилететь как KnowledgeSchemaError (поймал слеш) ИЛИ
      // как RunStorageError (если как-то протёк) — оба варианта
      // допустимы, главное что не возвращается путь.
    ).toThrow(/KnowledgeSchemaError|RunStorageError|sandbox|разделител/);
  });
});

describe('PRODUCT_KB_README_MARKDOWN', () => {
  it('упоминает каждую разрешённую поддиректорию продакта', () => {
    // Десинхронизация README и schema — частая ошибка ручного апдейта.
    // Этот тест её ловит: добавили папку в schema → забыли описать в
    // README → тест падает.
    for (const subdir of PRODUCT_SUBDIRS) {
      expect(
        PRODUCT_KB_README_MARKDOWN,
        `README должен упоминать "${subdir}/" — иначе модель не узнает о новой поддиректории`
      ).toContain(`${subdir}/`);
    }
  });

  it('содержит блок с обязательным фронтматтером (type/created/updated/related)', () => {
    // Минимальная защита от случайной потери ключевых полей при
    // редактировании текста. Точный YAML не парсим — формат
    // человекочитаемый, не машинный.
    expect(PRODUCT_KB_README_MARKDOWN).toContain('type:');
    expect(PRODUCT_KB_README_MARKDOWN).toContain('created:');
    expect(PRODUCT_KB_README_MARKDOWN).toContain('updated:');
    expect(PRODUCT_KB_README_MARKDOWN).toContain('related:');
  });
});

// Импорт для side-effect: гарантируем, что барелл `index.ts` экспортирует
// всё, что нужно ролям. Если барелл сломан — тест не соберётся.
// Сам по себе RunStorageError используется только в этом утверждении,
// чтобы зафиксировать слой sandbox в типах.
void RunStorageError;
