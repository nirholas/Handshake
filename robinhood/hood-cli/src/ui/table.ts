/**
 * Aligned table renderer. Column-aware padding, right-alignment for numeric
 * columns, dim rules, and a graceful narrow-terminal fallback that drops
 * lower-priority columns before it ever wraps.
 */
import { dim, gray, padEnd, padStart, width } from './ansi.js'

/** A column definition. */
export interface Column<Row> {
  /** Header label. */
  header: string
  /** Cell renderer — returns the already-styled string. */
  cell: (row: Row) => string
  /** Right-align (numbers) instead of left (text). @defaultValue false */
  align?: 'left' | 'right'
  /**
   * Drop priority when the terminal is too narrow: lower numbers drop first.
   * The first column is never dropped. @defaultValue 100
   */
  priority?: number
  /** Hard minimum width for this column. */
  min?: number
}

export interface TableOptions {
  /** Terminal width to fit into. @defaultValue process.stdout.columns ?? 80 */
  maxWidth?: number
  /** Gap between columns. @defaultValue 2 */
  gap?: number
}

/** Render rows as an aligned table string (no trailing newline). */
export function renderTable<Row>(
  rows: Row[],
  columns: Column<Row>[],
  options: TableOptions = {},
): string {
  const gap = options.gap ?? 2
  const maxWidth = options.maxWidth ?? process.stdout.columns ?? 80

  // Measure every column at full width.
  const measured = columns.map((col) => {
    const cells = rows.map((r) => col.cell(r))
    const contentWidth = Math.max(width(col.header), ...cells.map((c) => width(c)), 0)
    return { col, cells, contentWidth: Math.max(contentWidth, col.min ?? 0) }
  })

  // Drop low-priority columns (never the first) until it fits.
  const sep = ' '.repeat(gap)
  const totalWidth = (cols: typeof measured) =>
    cols.reduce((sum, m) => sum + m.contentWidth, 0) + gap * Math.max(0, cols.length - 1)

  let visible = measured
  if (totalWidth(visible) > maxWidth && visible.length > 1) {
    const dropOrder = visible
      .map((m, i) => ({ i, priority: m.col.priority ?? 100 }))
      .filter((x) => x.i !== 0)
      .sort((a, b) => a.priority - b.priority)
    const dropped = new Set<number>()
    for (const { i } of dropOrder) {
      if (totalWidth(visible.filter((_, idx) => !dropped.has(idx))) <= maxWidth) break
      dropped.add(i)
    }
    visible = measured.filter((_, idx) => !dropped.has(idx))
  }

  const line = (getCell: (m: (typeof visible)[number], rowIdx: number) => string, rowIdx: number) =>
    visible
      .map((m) => {
        const raw = getCell(m, rowIdx)
        return m.col.align === 'right'
          ? padStart(raw, m.contentWidth)
          : padEnd(raw, m.contentWidth)
      })
      .join(sep)

  const headerLine = visible
    .map((m) =>
      m.col.align === 'right'
        ? padStart(dim(m.col.header), m.contentWidth)
        : padEnd(dim(m.col.header), m.contentWidth),
    )
    .join(sep)

  const rule = gray('─'.repeat(Math.min(totalWidth(visible), maxWidth)))

  const body = rows.map((_, rowIdx) => line((m) => m.cells[rowIdx] as string, rowIdx))
  return [headerLine, rule, ...body].join('\n')
}

/** A simple two-column key/value block (for `tx`, `token`, single-record views). */
export function renderKeyValue(pairs: [string, string][], options: { labelWidth?: number } = {}): string {
  const labelWidth = options.labelWidth ?? Math.max(...pairs.map(([k]) => width(k)), 0)
  return pairs.map(([k, v]) => `${padEnd(dim(k), labelWidth)}  ${v}`).join('\n')
}
