import type { Meta, StoryObj } from '@storybook/react-vite';
import { Info } from 'lucide-react';
import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';

const meta: Meta<typeof Tooltip> = {
  title: 'Atoms/Tooltip',
  component: Tooltip,
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const OnIconButton: Story = {
  render: () => (
    <Tooltip content="Открыть настройки">
      <IconButton aria-label="Settings" icon={<Info size={14} aria-hidden />} />
    </Tooltip>
  ),
};

export const Sides: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 24, padding: 32 }}>
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <Tooltip key={side} content={`side="${side}"`} side={side}>
          <button
            type="button"
            style={{
              padding: '4px 8px',
              border: '1px solid var(--vscode-panel-border)',
              borderRadius: 2,
              background: 'transparent',
              color: 'var(--vscode-foreground)',
            }}
          >
            {side}
          </button>
        </Tooltip>
      ))}
    </div>
  ),
};
