import { describe, expect, it } from 'vitest'
import { bold, dim, green, red, stripAnsi, width, padEnd, padStart, truncate, setColorEnabled, colorIsEnabled } from '../../src/ui/ansi.js'

describe('color toggling', () => {
  it('emits no escape codes when disabled', () => {
    setColorEnabled(false)
    expect(colorIsEnabled()).toBe(false)
    expect(bold('hi')).toBe('hi')
    expect(red('hi')).toBe('hi')
  })
  it('emits escape codes when enabled', () => {
    setColorEnabled(true)
    expect(bold('hi')).toContain('\x1b[1m')
    expect(green('hi')).toContain('\x1b[32m')
    setColorEnabled(false)
  })
})

describe('stripAnsi / width', () => {
  it('strips escape codes and measures visible width', () => {
    setColorEnabled(true)
    const styled = dim('hello')
    expect(stripAnsi(styled)).toBe('hello')
    expect(width(styled)).toBe(5)
    setColorEnabled(false)
  })
  it('measures plain text unchanged', () => {
    expect(width('hello')).toBe(5)
  })
})

describe('padEnd / padStart', () => {
  it('pads plain text to a target width', () => {
    expect(padEnd('ab', 5)).toBe('ab   ')
    expect(padStart('ab', 5)).toBe('   ab')
  })
  it('pads ANSI-styled text by visible width, not raw length', () => {
    setColorEnabled(true)
    const styled = bold('ab') // raw length > 2 due to escape codes
    const padded = padEnd(styled, 5)
    expect(width(padded)).toBe(5)
    setColorEnabled(false)
  })
  it('does not truncate when already at/over width', () => {
    expect(padEnd('abcdef', 3)).toBe('abcdef')
  })
})

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('hi', 10)).toBe('hi')
  })
  it('truncates with an ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w…')
  })
})
