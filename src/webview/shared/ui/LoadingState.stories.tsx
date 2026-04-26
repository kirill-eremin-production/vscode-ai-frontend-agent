import type { Meta, StoryObj } from '@storybook/react-vite';
import { LoadingState } from './LoadingState';

const meta: Meta<typeof LoadingState> = {
  title: 'Atoms/LoadingState',
  component: LoadingState,
  args: { label: 'Архитектор думает…', size: 'sm' },
  argTypes: {
    label: { control: 'text' },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md'] },
  },
};

export default meta;
type Story = StoryObj<typeof LoadingState>;

export const Default: Story = {};

export const InHeader: Story = {
  render: () => (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: 4,
      }}
    >
      <strong style={{ fontSize: 13 }}>Run #42</strong>
      <LoadingState label="Продакт пишет brief…" />
    </header>
  ),
};
