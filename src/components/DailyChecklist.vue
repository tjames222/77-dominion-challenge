<script setup lang="ts">
import type { ChallengeStandard, DayEntry, StandardId } from '../types';

defineProps<{
  standards: ChallengeStandard[];
  entry: DayEntry;
}>();

const emit = defineEmits<{ toggle: [id: StandardId]; scheduled: [] }>();
</script>

<template>
  <section class="card checklist">
    <div class="section-heading">
      <p class="eyebrow">Today's Standard</p>
      <h2>Daily Scorecard</h2>
    </div>

    <button
      v-for="item in standards"
      :key="item.id"
      class="check-row"
      :class="{ checked: entry.completed.includes(item.id) }"
      @click="emit('toggle', item.id)"
    >
      <span class="box">✓</span>
      <span>
        <strong>{{ item.label }}</strong>
        <small>{{ item.detail ?? item.group }}</small>
      </span>
    </button>

    <button class="scheduled" :class="{ active: entry.scheduledMiss }" @click="emit('scheduled')">
      Scheduled miss day planned ahead
    </button>
  </section>
</template>