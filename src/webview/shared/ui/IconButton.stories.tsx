import type { Meta, StoryObj } from '@storybook/react-vite';
import { Settings, X, Plus } from 'lucide-react';
import { IconButton } from './IconButton';

const meta: Meta<typeof IconButton> = {
  title: 'Atoms/IconButton',
  component: IconButton,
  args: {
    'aria-label': 'Settings',
    icon: <Settings size={14} aria-hidden />,
    variant: 'ghost',
    size: 'md',
  },
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['primary', 'secondary', 'ghost', 'danger'],
    },
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <IconButton aria-label="Add" icon={<Plus size={14} aria-hidden />} variant="primary" />
      <IconButton
        aria-label="Settings"
        icon={<Settings size={14} aria-hidden />}
        variant="secondary"
      />
      <IconButton aria-label="Settings" icon={<Settings size={14} aria-hidden />} variant="ghost" />
      <IconButton aria-label="Close" icon={<X size={14} aria-hidden />} variant="danger" />
    </div>
  ),
};

export const Loading: Story = { args: { loading: true } };
