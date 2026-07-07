import { getCommunityFeed, hasSupabaseAuth } from './api';

const tabs = Array.from(document.querySelectorAll('.community-tab'));
const panels = Array.from(document.querySelectorAll('.community-panel'));

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === target));
  });
});

function statusLabel(item) {
  if (item.status === 'scheduled') return 'scheduled a planned miss day';
  if (item.status === 'partial') return `posted a partial check-in${item.completedCount ? ` (${item.completedCount}/7)` : ''}`;
  return 'completed the day';
}

async function hydrateCommunityFeed() {
  if (!hasSupabaseAuth()) return;

  try {
    const feed = await getCommunityFeed();
    if (!Array.isArray(feed) || !feed.length) return;
    const lists = document.querySelectorAll('.feed-list');
    lists.forEach((list) => {
      list.innerHTML = feed.slice(0, 8).map((item) => `
        <article class="feed-card card">
          <div>
            <strong>${item.name}</strong>
            <span>Day ${item.day}</span>
          </div>
          <p>${statusLabel(item)} · ${item.timestamp}</p>
        </article>
      `).join('');
    });
  } catch (error) {
    console.warn('Unable to load community feed from Supabase', error);
  }
}

hydrateCommunityFeed();
