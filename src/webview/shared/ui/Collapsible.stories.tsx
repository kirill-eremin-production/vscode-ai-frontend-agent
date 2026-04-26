import type { Meta, StoryObj } from '@storybook/react-vite';
import { Collapsible } from './Collapsible';

const meta: Meta<typeof Collapsible> = {
  title: 'Atoms/Collapsible',
  component: Collapsible,
};

export default meta;
type Story = StoryObj<typeof Collapsible>;

export const Default: Story = {
  args: {
    trigger: <code>read_kb_file</code>,
    children: (
      <pre style={{ margin: 0, fontSize: 11 }}>{`{\n  "path": "product/briefs/brief.md"\n}`}</pre>
    ),
  },
};

export const Opened: Story = {
  args: {
    defaultOpen: true,
    trigger: 'Аргументы вызова',
    children: <span>Контент по умолчанию открыт.</span>,
  },
};
