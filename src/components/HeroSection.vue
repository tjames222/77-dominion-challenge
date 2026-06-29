<script setup lang="ts">
import { THEME_VERSE } from '../data/challenge';
</script>

<template>
  <section class="hero card">
    <p class="eyebrow">77-Day Dominion Challenge</p>
    <h1>Honor God. Master Yourself.</h1>
    <p class="lead">Build discipline in spirit, mind, and body through daily prayer, Scripture, worship, movement, and accountability.</p>
    <blockquote>
      “{{ THEME_VERSE.text }}”
      <strong>{{ THEME_VERSE.reference }}</strong>
    </blockquote>
  </section>
</template>