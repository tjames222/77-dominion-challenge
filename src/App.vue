<script setup lang="ts">
import { computed } from 'vue';
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
const dominionPoster = computed(() => (
  theme.isDark.value ? '/images/dominion-athlete-poster.png' : '/images/dominion-athlete-poster-light.svg'
));

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
        <span class="brand-mark">77</span>
        <span class="brand-name">Dominion</span>
      </div>
      <button class="theme-toggle" @click="theme.toggleTheme">
        {{ theme.label.value }} Theme
      </button>
    </header>

    <HeroSection />

    <section class="card" aria-label="77 Days. No excuses. Only faithfulness.">
      <img :src="dominionPoster" alt="77 Days. No excuses. Only faithfulness. Dominion Challenge." style="display: block; width: 100%; height: auto; border-radius: 16px;" />
    </section>

    <details class="card challenge-details">
      <summary>
        <span>
          <span class="eyebrow">About the Challenge</span>
          <strong>What is the 77-Day Dominion Challenge?</strong>
        </span>
        <span class="summary-icon">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M6 9L12 15L18 9"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </summary>
      <div class="details-body">
        <p>
          The 77-Day Dominion Challenge is a focused season of spiritual, mental, and physical discipline. It is designed to help you honor God, steward your body, and train yourself to keep commitments even when motivation fades.
        </p>
        <p>
          Each day is built around seven standards: reading 5–8 chapters of the Bible, praying morning and evening, listening only to worship music, completing two intentional workouts, and taking an intentional walk during the day.
        </p>
        <p>
          Workouts do not have a required length. Some days may be intense. Other days may be recovery-focused with stretching, mobility, walking, or light movement. The goal is consistency, not recklessness.
        </p>
        <p>
          Scheduled miss days are allowed when planned ahead. Unplanned misses because of laziness, busyness, tiredness, or poor planning are not the spirit of the challenge.
        </p>
        <ul>
          <li><strong>Spirit:</strong> Bible reading, morning prayer, evening prayer.</li>
          <li><strong>Mind:</strong> Worship music only.</li>
          <li><strong>Body:</strong> Workout #1, intentional walk, workout #2.</li>
          <li><strong>Accountability:</strong> Check in honestly and stay connected with others doing the challenge.</li>
        </ul>
      </div>
    </details>

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
