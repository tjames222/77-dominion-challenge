<script setup lang="ts">
import type { MemberCheckIn } from '../types';

defineProps<{ feed: MemberCheckIn[]; completedToday: number }>();
</script>

<template>
  <section class="card community">
    <div class="section-heading">
      <p class="eyebrow">Accountability</p>
      <h2>{{ completedToday }} people completed today</h2>
    </div>
    <article v-for="item in feed.slice(0, 6)" :key="item.id" class="feed-item">
      <div>
        <strong>{{ item.name }}</strong>
        <p>Day {{ item.day }} {{ item.status === 'complete' ? 'complete' : 'scheduled miss' }}</p>
      </div>
      <span>{{ item.status === 'complete' ? '✓' : '↺' }}</span>
    </article>
  </section>
</template>