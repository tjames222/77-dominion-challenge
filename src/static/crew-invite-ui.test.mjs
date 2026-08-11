import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const dialog = readFileSync(new URL('./crew-invite-dialog.js', import.meta.url), 'utf8');
const community = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const invitePage = readFileSync(new URL('../../invite.html', import.meta.url), 'utf8');
const inviteClient = readFileSync(new URL('./invite.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/crew-invite.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('crew invitation Link, Code, and QR interface', () => {
  test('uses one dedicated, explicit-generation invitation dialog', () => {
    assert.match(community, /id="copyInviteButton"/);
    assert.doesNotMatch(community, /id="copyInviteButton"[^>]*data-share-composer/);
    assert.match(dialog, /title: 'Invite People'/);
    assert.match(dialog, /Generate invitation/);
    assert.match(dialog, /issueCrewInviteBundle\(currentCrew\.id/);
    assert.doesNotMatch(dialog.match(/onOpen:[\s\S]*?onClose:/)?.[0] || '', /issueCrewInviteBundle/);
  });

  test('presents three accessible views of the same lifecycle', () => {
    assert.match(dialog, /setAttribute\('role', 'tablist'\)/);
    assert.match(dialog, /\['link', 'Link'\][\s\S]*\['code', 'Code'\][\s\S]*\['qr', 'QR'\]/);
    assert.match(dialog, /setAttribute\('aria-selected'/);
    assert.match(dialog, /nextInviteTabIndex/);
    assert.match(dialog, /Using, revoking, replacing, or expiring one invalidates every format/);
    assert.match(dialog, /Replace invitation/);
    assert.match(dialog, /Revoke invitation/);
  });

  test('restores a usable lifecycle after replacement generation fails', () => {
    const generateBody = dialog.match(
      /async function generateInvitation\(\) \{[\s\S]*?\n  \}\n\n  function beginLifecycleConfirmation/,
    )?.[0] || '';
    const failureBody = generateBody.match(/\} catch \(error\) \{[\s\S]*?\n    \} finally \{/)?.[0] || '';

    assert.match(
      failureBody,
      /if \(version !== requestVersion\) return;[\s\S]*?clearSecrets\(\);[\s\S]*?confirmation\.hidden = true;/,
    );
    assert.match(failureBody, /renderLifecycle\(\);/);
    assert.match(
      failureBody,
      /recoveryFocus = metadata\.status === 'active' \? replaceButton : generateButton;/,
    );
    assert.doesNotMatch(failureBody, /bundle\s*=/);
    assert.match(
      generateBody,
      /setButtonBusyState\(allActionButtons, false\);[\s\S]*?recoveryFocus\?\.focus\(\)/,
    );
  });

  test('renders and exports the QR locally without a hosted QR endpoint', () => {
    assert.equal(packageJson.dependencies.qrcode, '1.5.4');
    assert.equal(packageJson.devDependencies.jsqr, '1.4.0');
    assert.match(dialog, /import QRCode from 'qrcode'/);
    assert.match(dialog, /QRCode\.toCanvas/);
    assert.match(dialog, /dominion-crew-invite\.png/);
    assert.doesNotMatch(dialog, /https?:\/\//);
    assert.doesNotMatch(dialog, /fetch\(|XMLHttpRequest|\bImage\s*\(/);
  });

  test('revalidates actor and crew authorization and clears credentials on close', () => {
    assert.match(dialog, /actor\.userId !== actorId/);
    assert.match(dialog, /!\['owner', 'admin'\]\.includes\(crew\.role\)/);
    assert.match(dialog, /onClose: \(\) => clearAccountScopedState\(\)/);
    assert.match(dialog, /bundle = null/);
    assert.match(dialog, /linkInput\.value = ''/);
    assert.match(dialog, /codeOutput\.textContent = ''/);
    assert.match(dialog, /qrCanvas\.width = 0/);
    assert.match(dialog, /subscribeToAuthStateChanges/);
    assert.match(dialog, /if \(!event\?\.persisted\) destroy\(\)/);
    assert.doesNotMatch(dialog, /addEventListener\?\.\('pagehide', destroy/);
    assert.match(dialog, /event === 'SIGNED_OUT'/);
    assert.match(dialog, /user\.userId !== actorId/);
    assert.match(dialog, /event\?\.key === 'dominion:user'/);
    assert.match(dialog, /event\?\.key === null/);
    assert.match(dialog, /const invite = await issueCrewInviteBundle[\s\S]*?await currentActor\(\)/);
    assert.match(dialog, /const pendingQrBlob = await canvasToPngBlob\(pendingQrCanvas\)[\s\S]*?await currentActor\(\)[\s\S]*?bundle =/);
    assert.match(dialog, /dialog\.destroy\(\)/);
    assert.match(dialog, /boundTriggers\.delete\(boundTrigger\)/);
    assert.match(api, /client\.rpc\('issue_crew_invite_bundle'[\s\S]*?await requireUser\(actor\.id\)/);
  });

  test('keeps code and link credentials out of persisted mock invitation data', () => {
    const issueBody = api.match(/export async function issueCrewInviteBundle[\s\S]*?export async function getActiveCrewInvite/)?.[0] || '';
    assert.match(issueBody, /token_hash: await sha256Hex\(token\)/);
    assert.match(issueBody, /code_hash: await sha256Hex\(normalizeCrewInviteCode\(code\)\)/);
    assert.match(issueBody, /code_hint: code\.slice\(-4\)/);
    assert.doesNotMatch(issueBody.match(/const invite = \{[\s\S]*?\n    \};/)?.[0] || '', /\btoken,|\bcode,/);
    assert.match(api, /preview_crew_invite_code/);
    assert.match(api, /sourceCount !== 1/);
  });

  test('offers focused code entry and preserves explicit confirmation', () => {
    assert.match(community, /id="joinCrewButton"/);
    assert.match(invitePage, /id="inviteCodeForm"/);
    assert.match(invitePage, /autocomplete="off"/);
    assert.match(invitePage, /spellcheck="false"/);
    assert.match(inviteClient, /status === 'enter_code'[\s\S]*?focus\(\)/);
    assert.match(inviteClient, /previewCrewInvite\(\{[\s\S]*?code: rawInviteCode/);
    assert.match(inviteClient, /confirmInviteButton[^\n]*addEventListener\('click'/);
  });

  test('provides mobile, forced-colors, reduced-motion, and minimum-target styles', () => {
    assert.match(css, /min-height:\s*44px/);
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /\.crew-invite-tab:focus-visible/);
  });
});
