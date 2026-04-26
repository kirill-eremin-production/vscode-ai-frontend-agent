import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from './Spinner';

const meta: Meta<typeof Spinner> = {
  title: 'Atoms/Spinner',
  component: Spinner,
  argTypes: {
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md'] },
    label: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof Spinner>;

export const Default: Story = { args: { size: 'sm' } };

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Spinner size="xs" />
      <Spinner size="sm" />
      <Spinner size="md" />
    </div>
  ),
};

export const InsideText: Story = {
  render: () => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Spinner size="xs" />
      Цвет наследуется от currentColor
    </span>
  ),
};
