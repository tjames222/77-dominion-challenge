export const DAILY_STANDARD_ROUTES = Object.freeze({
  bible: Object.freeze({
    id: 'bible', title: 'Bible Reading', shortTitle: 'Bible Reading', route: './bible-reading.html', icon: 'icon-bible', group: 'Mind',
  }),
  morningPrayer: Object.freeze({
    id: 'morningPrayer', title: 'Morning Prayer', shortTitle: 'Morning Prayer', route: './morning-prayer.html', icon: 'icon-prayer', group: 'Spirit',
  }),
  worshipOnly: Object.freeze({
    id: 'worshipOnly', title: 'Worship Music Only', shortTitle: 'Worship', route: './worship.html', icon: 'icon-music', group: 'Spirit',
  }),
  eveningPrayer: Object.freeze({
    id: 'eveningPrayer', title: 'Evening Prayer', shortTitle: 'Evening Prayer', route: './evening-prayer.html', icon: 'icon-prayer', group: 'Spirit',
  }),
  workoutOne: Object.freeze({
    id: 'workoutOne', title: 'Workout #1', shortTitle: 'Workout #1', route: './workout-one.html', icon: 'icon-dumbbell', group: 'Body', workoutId: 'one',
  }),
  walk: Object.freeze({
    id: 'walk', title: 'Intentional Walk', shortTitle: 'Intentional Walk', route: './intentional-walk.html', icon: 'icon-walk', group: 'Body',
  }),
  workoutTwo: Object.freeze({
    id: 'workoutTwo', title: 'Workout #2', shortTitle: 'Workout #2', route: './workout-two.html', icon: 'icon-run', group: 'Body', workoutId: 'two',
  }),
});

export const DAILY_STANDARD_ROUTE_LIST = Object.freeze(Object.values(DAILY_STANDARD_ROUTES));

export function dailyStandardRoute(actionId) {
  return DAILY_STANDARD_ROUTES[actionId] || null;
}
