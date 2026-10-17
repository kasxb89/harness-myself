/** Model-facing draft directions read retained facts before replacing a plan. */
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

it('reads the complete retained plan before every localized revision or redo update', () => {
  for (const dictionary of [zh, en]) {
    for (const key of ['draft.redo', 'draft.edit', 'draft.character', 'draft.asset'] as const) {
      const text = dictionary[key]
      expect(text).toContain('get_creation_plan')
      expect(text.indexOf('get_creation_plan')).toBeLessThan(text.indexOf('update_creation_plan'))
    }
  }
})
