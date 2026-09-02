import type { UserSettingsSchema } from '@/api/user-settings';
import { useUserSettings } from '@/composable/data-queries/user-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { DEFAULT_COLUMN_ORDER, DEFAULT_VISIBLE_COLUMNS, TABLE_COLUMN } from './columns';
import { useTableColumns } from './use-table-columns';

vi.mock('@/composable/data-queries/user-settings', () => ({ useUserSettings: vi.fn() }));

const patchSettings = vi.fn();

const mockSettings = (settings?: UserSettingsSchema) => {
  vi.mocked(useUserSettings).mockReturnValue({
    data: ref(settings),
    patch: patchSettings,
  } as unknown as ReturnType<typeof useUserSettings>);
};

describe('useTableColumns balance column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Balance after Amount in the default layout', () => {
    mockSettings();
    const { visibleColumns } = useTableColumns();
    const ids = visibleColumns.value.map((column) => column.id);

    expect(ids).toEqual(DEFAULT_COLUMN_ORDER.filter((id) => DEFAULT_VISIBLE_COLUMNS.includes(id)));
    expect(ids.indexOf(TABLE_COLUMN.balance)).toBe(ids.indexOf(TABLE_COLUMN.amount) + 1);
  });

  it('inserts and enables Balance for a saved layout created before the column existed', () => {
    mockSettings({
      ui: {
        transactionsTable: {
          visibleColumns: [TABLE_COLUMN.date, TABLE_COLUMN.amount, TABLE_COLUMN.note],
          columnOrder: [TABLE_COLUMN.date, TABLE_COLUMN.amount, TABLE_COLUMN.note],
        },
      },
    });
    const { visibleColumns, configurableColumns } = useTableColumns();

    expect(visibleColumns.value.map((column) => column.id)).toEqual([
      TABLE_COLUMN.date,
      TABLE_COLUMN.amount,
      TABLE_COLUMN.balance,
      TABLE_COLUMN.note,
    ]);
    const order = configurableColumns.value.map(({ definition }) => definition.id);
    expect(order.indexOf(TABLE_COLUMN.balance)).toBe(order.indexOf(TABLE_COLUMN.amount) + 1);
  });

  it('preserves an explicit choice to hide Balance once the saved order knows about it', () => {
    mockSettings({
      ui: {
        transactionsTable: {
          visibleColumns: [TABLE_COLUMN.date, TABLE_COLUMN.amount],
          columnOrder: [TABLE_COLUMN.date, TABLE_COLUMN.amount, TABLE_COLUMN.balance],
        },
      },
    });
    const { visibleColumns } = useTableColumns();

    expect(visibleColumns.value.map((column) => column.id)).not.toContain(TABLE_COLUMN.balance);
  });

  it('can exclude Balance from table surfaces that do not request enrichment', () => {
    mockSettings();
    const { visibleColumns, configurableColumns } = useTableColumns({ excludedColumns: [TABLE_COLUMN.balance] });

    expect(visibleColumns.value.map((column) => column.id)).not.toContain(TABLE_COLUMN.balance);
    expect(configurableColumns.value.map(({ definition }) => definition.id)).not.toContain(TABLE_COLUMN.balance);
  });
});
