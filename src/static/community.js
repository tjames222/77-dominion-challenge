import { getBillingState, getCommunityFeed, hasSupabaseAuth, isLocalDemoMode, redirectToLogin } from './api';

const tabs = Array.from(document.querySelectorAll('.community-tab'));
const panels = Array.from(document.querySelectorAll('.community-panel'));
const membershipTitle = document.getElementById('communityMembershipTitle');
const membershipCopy = document.getElementById('communityMembershipCopy');
const membershipLink = document.getElementById('communityMembershipLink');

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
  if (!hasSupabaseAuth() && isLocalDemoMode()) return;
  if (!hasSupabaseAuth()) {
    redirectToLogin('./community.html');
    return;
  }

  try {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./community.html');
      return;
    }

    if (membershipTitle && membershipCopy) {
      if (billing.membershipActive) {
        membershipTitle.textContent = 'Membership is active.';
        membershipCopy.textContent = 'Your premium accountability tools are available, including richer crew follow-up and private journaling layers.';
        if (membershipLink) {
          membershipLink.textContent = 'Manage membership';
          membershipLink.href = './profile.html#billing';
        }
      } else {
        membershipTitle.textContent = 'Basic community is open.';
        membershipCopy.textContent = 'Membership unlocks premium accountability circles, private crew tools, and richer follow-up after the 77-day challenge.';
      }
    }

    document.querySelectorAll('[data-premium-action]').forEach((button) => {
      if (billing.membershipActive) {
        button.disabled = false;
        return;
      }
      button.textContent = 'Unlock membership to use this';
      button.addEventListener('click', () => {
        window.location.href = './billing.html?intent=membership';
      });
    });

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
