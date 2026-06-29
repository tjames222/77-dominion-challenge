<script setup lang="ts">
import HeroSection from './components/HeroSection.vue';
import DailyChecklist from './components/DailyChecklist.vue';
import CommunityFeed from './components/CommunityFeed.vue';
import ProgressRing from './components/ProgressRing.vue';
import { useChallenge } from './composables/useChallenge';
import { useCommunity } from './composables/useCommunity';
import { useTheme } from './composables/useTheme';

const challenge = useChallenge();
const community = useCommunity();
const theme = useTheme();

function checkIn() {
  community.addCheckIn(
    challenge.memberName.value || 'Anonymous',
    challenge.currentDay.value,
    challenge.todaysEntry.value.scheduledMiss ? 'scheduled' : 'complete',
  );
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <span class="brand-mark">D</span>
        <span class="brand-name">Dominion</span>
      </div>
      <button class="theme-toggle" @click="theme.toggleTheme">
        {{ theme.label.value }} Theme
      </button>
    </header>

    <HeroSection />

    <section class="dashboard card">
      <label>
        Your name
        <input v-model="challenge.memberName.value" placeholder="Tim" />
      </label>
      <label>
        Challenge start date
        <input v-model="challenge.startDate.value" type="date" />
      </label>
      <div class="rings">
        <ProgressRing :value="challenge.progressPercent.value" label="Challenge" :sublabel="`Day ${challenge.currentDay.value} of 77`" />
        <ProgressRing :value="challenge.todayPercent.value" label="Today" :sublabel="`${challenge.completedCount.value} of 7 done`" />
      </div>
      <button class="primary" :disabled="!challenge.isComplete.value && !challenge.todaysEntry.value.scheduledMiss" @click="checkIn">
        Post Check-In
      </button>
    </section>

    <DailyChecklist
      :standards="challenge.standards"
      :entry="challenge.todaysEntry.value"
      @toggle="challenge.toggleStandard"
      @scheduled="challenge.toggleScheduledMiss"
    />

    <section class="card rules">
      <p class="eyebrow">Rules</p>
      <ul>
        <li>Commit to 77 days of intentional discipline.</li>
        <li>Scheduled miss days are allowed only when planned ahead.</li>
        <li>No missing because of laziness, tiredness, busyness, or poor planning.</li>
        <li>When life changes, adapt the standard instead of abandoning it.</li>
      </ul>
    </section>

    <CommunityFeed :feed="community.feed.value" :completed-today="community.completedToday.value" />
  </main>
</template>
