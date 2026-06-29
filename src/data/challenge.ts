import type { ChallengeStandard, MemberCheckIn } from '../types';

export const TOTAL_DAYS = 77;

export const THEME_VERSE = {
  text: 'But I discipline my body and keep it under control, lest after preaching to others I myself should be disqualified.',
  reference: '1 Corinthians 9:27',
};

export const standards: ChallengeStandard[] = [
  { id: 'bible', label: 'Bible Reading', detail: '5–8 chapters', group: 'Spirit' },
  { id: 'morningPrayer', label: 'Morning Prayer', group: 'Spirit' },
  { id: 'eveningPrayer', label: 'Evening Prayer', group: 'Spirit' },
  { id: 'worshipOnly', label: 'Worship Music Only', detail: 'Instrumental, podcasts, and audiobooks permitted', group: 'Mind' },
  { id: 'workoutOne', label: 'Workout #1', detail: 'No required length', group: 'Body' },
  { id: 'walk', label: 'Intentional Walk', detail: 'During the day', group: 'Body' },
  { id: 'workoutTwo', label: 'Workout #2', detail: 'No required length', group: 'Body' },
];

export const starterFeed: MemberCheckIn[] = [
  { id: '1', name: 'Josh', day: 12, status: 'complete', timestamp: 'Today' },
  { id: '2', name: 'Sarah', day: 12, status: 'complete', timestamp: 'Today' },
  { id: '3', name: 'Matt', day: 11, status: 'scheduled', timestamp: 'Yesterday' },
  { id: '4', name: 'Tim', day: 12, status: 'complete', timestamp: 'Today' },
];