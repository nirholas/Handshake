import { NoxaRail } from './noxa.js'
import { OdysseyRail } from './odyssey.js'
import { DirectRail } from './direct.js'
import type { Rail, RailName } from './types.js'

export { NoxaRail } from './noxa.js'
export { OdysseyRail } from './odyssey.js'
export { DirectRail } from './direct.js'
export * from './types.js'
export * from './addresses.js'

/** Instantiate a rail by name. `odysseyVariant` selects Odyssey's factory (`'instant'` default). */
export function createRail(name: RailName, odysseyVariant: 'instant' | 'bonding' = 'instant'): Rail {
  switch (name) {
    case 'noxa':
      return new NoxaRail()
    case 'odyssey':
      return new OdysseyRail(odysseyVariant)
    case 'direct':
      return new DirectRail()
  }
}

export const ALL_RAILS: RailName[] = ['noxa', 'odyssey', 'direct']
