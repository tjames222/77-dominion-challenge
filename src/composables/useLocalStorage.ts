import { ref, watch, type Ref } from 'vue';

export function useLocalStorage<T>(key: string, initialValue: T): Ref<T> {
  const stored = window.localStorage.getItem(key);
  const state = ref<T>(stored ? JSON.parse(stored) as T : initialValue) as Ref<T>;

  watch(state, value => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { deep: true });

  return state;
}