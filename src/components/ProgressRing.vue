<script setup lang="ts">
defineProps<{ value: number; label: string; sublabel: string }>();
</script>

<template>
  <div class="ring" :style="{ '--value': `${value}%` }">
    <div class="ring-inner">
      <strong>{{ value }}%</strong>
      <span>{{ label }}</span>
      <small>{{ sublabel }}</small>
    </div>
  </div>
</template>