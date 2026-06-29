export type StandardId =
  | 'bible'
  | 'morningPrayer'
  | 'worshipOnly'
  | 'workoutOne'
  | 'walk'
  | 'workoutTwo'
  | 'eveningPrayer';

export interface ChallengeStandard {
  id: StandardId;
  label: string;
  detail?: string;
  group: 'Spirit' | 'Mind' | 'Body';
}

export interface DayEntry {
  date: string;
  completed: StandardId[];
  scheduledMiss?: boolean;
  note?: string;
}

export interface MemberCheckIn {
  id: string;
  name: string;
  day: number;
  status: 'complete' | 'scheduled';
  timestamp: string;
}