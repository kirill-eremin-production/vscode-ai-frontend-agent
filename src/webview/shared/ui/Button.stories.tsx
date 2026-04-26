import type { Meta, StoryObj } from '@storybook/react-vite';
import { Save, Trash2 } from 'lucide-react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Atoms/Button',
  component: Button,
  args: { children: 'Click me', variant: 'primary', size: 'md' },
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
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Ghost: Story = { args: { variant: 'ghost' } };
export const Danger: Story = { args: { variant: 'danger' } };

export const WithIcons: Story = {
  args: {
    iconLeft: <Save size={12} aria-hidden />,
    children: 'Save changes',
  },
};

export const Loading: Story = { args: { loading: true } };
export const Disabled: Story = { args: { disabled: true } };

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" iconLeft={<Trash2 size={12} aria-hidden />}>
          Delete
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button loading>Loading</Button>
        <Button disabled>Disabled</Button>
      </div>
    </div>
  ),
};
