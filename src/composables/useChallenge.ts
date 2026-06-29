import { computed } from 'vue';
import { standards, TOTAL_DAYS } from '../data/challenge';
import type { DayEntry, StandardId } from '../types';
import { useLocalStorage } from './useLocalStorage';

const todayKey = () => new Date().toISOString().slice(0, 10);

export function useChallenge() {
  const startDate = useLocalStorage<string>('dominion:startDate', todayKey());
  const entries = useLocalStorage<DayEntry[]>('dominion:entries', []);
  const memberName = useLocalStorage<string>('dominion:memberName', '');

  const currentDay = computed(() => {
    const start = new Date(`${startDate.value}T00:00:00`);
    const today = new Date(`${todayKey()}T00:00:00`);
    const diff = Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1;
    return Math.min(Math.max(diff, 1), TOTAL_DAYS);
  });

  const todaysEntry = computed<DayEntry>(() => {
    const existing = entries.value.find(entry => entry.date === todayKey());
    return existing ?? { date: todayKey(), completed: [] };
  });

  const completedCount = computed(() => todaysEntry.value.completed.length);
  const isComplete = computed(() => completedCount.value === standards.length);
  const progressPercent = computed(() => Math.round((currentDay.value / TOTAL_DAYS) * 100));
  const todayPercent = computed(() => Math.round((completedCount.value / standards.length) * 100));

  function saveEntry(entry: DayEntry) {
    const index = entries.value.findIndex(item => item.date === entry.date);
    if (index >= 0) entries.value.splice(index, 1, entry);
    else entries.value.push(entry);
  }

  function toggleStandard(id: StandardId) {
    const entry = { ...todaysEntry.value, completed: [...todaysEntry.value.completed] };
    entry.completed = entry.completed.includes(id)
      ? entry.completed.filter(item => item !== id)
      : [...entry.completed, id];
    saveEntry(entry);
  }

  function toggleScheduledMiss() {
    saveEntry({
      ...todaysEntry.value,
      scheduledMiss: !todaysEntry.value.scheduledMiss,
    });
  }

  return {
    startDate,
    entries,
    memberName,
    currentDay,
    todaysEntry,
    completedCount,
    isComplete,
    progressPercent,
    todayPercent,
    standards,
    toggleStandard,
    toggleScheduledMiss,
  };
}