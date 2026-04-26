import { Sparkles } from 'lucide-react';
import { Button, EmptyState, Tooltip } from '@shared/ui';
import { startNewRun, useRunsState } from '@shared/runs/store';

/**
 * Empty-state main-area (#0018): пользователь ещё ничего не выбрал и
 * у него либо нет ранов, либо он закрыл текущий выбор. Цель экрана —
 * предложить осмысленный первый шаг, а не выглядеть «пустотой».
 *
 * CTA «Новый ран» дублирует кнопку из шапки списка (тот же `startNewRun`).
 * Без открытого workspace кнопка disabled с tooltip'ом — точно так же,
 * как в RunListPanel: нельзя завести ран в ничто (US-5).
 */
export function MainEmptyState() {
  const { hasWorkspace } = useRunsState();

  const button = (
    <Button
      variant="primary"
      onClick={startNewRun}
      disabled={!hasWorkspace}
      iconLeft={<Sparkles size={14} aria-hidden />}
    >
      Новый ран
    </Button>
  );

  return (
    <div className="flex flex-1 items-center justify-center min-h-0">
      <EmptyState
        icon={Sparkles}
        title="Запустите команду агентов"
        description="Расширение организует диалог продакта, архитектора и других ролей вокруг одного запроса. Опишите задачу — агенты разберут её на брифы, планы и артефакты."
        cta={
          hasWorkspace ? (
            button
          ) : (
            <Tooltip content="Откройте папку проекта">
              {/* span — чтобы tooltip ловил hover/focus у disabled-кнопки */}
              <span className="inline-flex">{button}</span>
            </Tooltip>
          )
        }
      />
    </div>
  );
}
