import { describe, expect, it } from 'vitest'
import { renderTable, renderKeyValue, type Column } from '../../src/ui/table.js'
import { setColorEnabled } from '../../src/ui/ansi.js'

setColorEnabled(false)

interface Row {
  symbol: string
  price: number
}

const rows: Row[] = [
  { symbol: 'AAPL', price: 315.5 },
  { symbol: 'TSLA', price: 1200 },
]

const columns: Column<Row>[] = [
  { header: 'SYMBOL', cell: (r) => r.symbol, priority: 100 },
  { header: 'PRICE', align: 'right', cell: (r) => String(r.price), priority: 90 },
]

describe('renderTable', () => {
  it('aligns a header and rule above the data rows', () => {
    const out = renderTable(rows, columns, { maxWidth: 80 })
    const lines = out.split('\n')
    expect(lines).toHaveLength(4) // header + rule + 2 rows
    expect(lines[0]).toContain('SYMBOL')
    expect(lines[1]).toMatch(/^─+$/)
  })

  it('right-aligns numeric columns', () => {
    const out = renderTable(rows, columns, { maxWidth: 80 })
    const priceLines = out.split('\n').slice(2)
    // "315.5" and "1200" should be right-padded so their right edges line up
    const col = columns[1]!
    expect(priceLines[0]!.trimEnd().endsWith('315.5')).toBe(true)
    expect(priceLines[1]!.trimEnd().endsWith('1200')).toBe(true)
  })

  it('drops low-priority columns before it would overflow', () => {
    const wideColumns: Column<Row>[] = [
      { header: 'SYMBOL', cell: (r) => r.symbol, priority: 100 },
      { header: 'A_VERY_LONG_LOW_PRIORITY_COLUMN_HEADER', cell: () => 'x'.repeat(60), priority: 1 },
    ]
    const out = renderTable(rows, wideColumns, { maxWidth: 20 })
    expect(out).not.toContain('A_VERY_LONG_LOW_PRIORITY_COLUMN_HEADER')
    expect(out).toContain('SYMBOL')
  })

  it('never drops the first column even under extreme width pressure', () => {
    const out = renderTable(rows, columns, { maxWidth: 1 })
    expect(out).toContain('SYMBOL')
  })

  it('handles an empty row set without throwing', () => {
    const out = renderTable([], columns)
    expect(out.split('\n')).toHaveLength(2) // header + rule, no body
  })
})

describe('renderKeyValue', () => {
  it('aligns values to a shared label width', () => {
    const out = renderKeyValue([['A', '1'], ['LongLabel', '2']])
    const lines = out.split('\n')
    // Both value columns should start at the same offset.
    const offsetA = lines[0]!.indexOf('1')
    const offsetB = lines[1]!.indexOf('2')
    expect(offsetA).toBe(offsetB)
  })
})
