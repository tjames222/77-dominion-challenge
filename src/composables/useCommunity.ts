import { computed } from 'vue';
import { starterFeed } from '../data/challenge';
import type { MemberCheckIn } from '../types';
import { useLocalStorage } from './useLocalStorage';

export function useCommunity() {
  const feed = useLocalStorage<MemberCheckIn[]>('dominion:feed', starterFeed);

  const completedToday = computed(() => feed.value.filter(item => item.status === 'complete' && item.timestamp === 'Today').length);

  function addCheckIn(name: string, day: number, status: MemberCheckIn['status']) {
    if (!name.trim()) return;
    feed.value.unshift({
      id: crypto.randomUUID(),
      name: name.trim(),
      day,
      status,
      timestamp: 'Today',
    });
  }

  return { feed, completedToday, addCheckIn };
}