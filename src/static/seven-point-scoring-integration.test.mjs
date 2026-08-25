import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { DAILY_STANDARD_ROUTE_LIST } from './daily-standard-routes.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('seven-point scoring integration', () => {
  it('shows an accessible +1 on every actionable surface without aggregate preview cards', async () => {
    const [dashboardHtml, dashboardSource, styles, ...actionPages] = await Promise.all([
      read('../../dashboard.html'),
      read('./dashboard.js'),
      read('../assets/styles.css'),
      ...DAILY_STANDARD_ROUTE_LIST.map((action) => read(`../..${action.route.slice(1)}`)),
    ]);

    for (const source of [dashboardHtml, ...actionPages]) {
      assert.doesNotMatch(source, /Projected award|Full-day potential|difficulty bonus|data-difficulty-point/i);
    }
    assert.match(dashboardSource, /class=\"action-point-value\" aria-label=\"1 point\">\+1/);
    actionPages.forEach((page) => assert.match(page, /aria-label="1 point">\+1/));
    assert.match(styles, /\.action-point-value\s*\{/);
  });

  it('enforces one point per completed standard at the trusted data layer', async () => {
    const [schema, migration] = await Promise.all([
      read('../../supabase/schema.sql'),
      read('../../supabase/migrations/20260719120000_seven_point_scoring.sql'),
    ]);
    const rewardFunction = schema.slice(
      schema.indexOf('create or replace function public.process_check_in_game_rewards'),
      schema.indexOf('drop trigger if exists process_check_in_game_rewards_before_insert'),
    );
    const visitFunction = schema.slice(
      schema.indexOf('create or replace function public.record_app_visit'),
      schema.indexOf('drop function if exists public.get_global_leaderboard'),
    );

    assert.match(rewardFunction, /action_points := least\(greatest\(new\.completed_count, 0\), 7\)/);
    assert.doesNotMatch(rewardFunction, /bonus_points|workout_points|full_day_streak_bonus/);
    assert.doesNotMatch(visitFunction, /add_game_points|'app_visit'|'app_streak_bonus'/);
    assert.match(migration, /target_event_type = 'check_in'[\s\S]+completedCount[\s\S]+\), 7\)/);
    assert.match(migration, /new\.points_awarded := least\(greatest\(cardinality/);
    assert.match(migration, /drop table if exists public\.workout_difficulty_point_values/);
  });
});
