/** Explicit test-only navigation to the retained optional Schedule catalog. */
window.__ModuleLoader__.load({
  id: '@fixture/schedule-catalog',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'schedules',
          order: 60,
          label: () => 'Fixture task catalog',
        }, ({ size }) => React.createElement('span', {
          'aria-hidden': true,
          style: { fontSize: size, lineHeight: 1 },
        }, '◷')))
      },
    }
  },
})
