import {buildOwnedDraftInspectionExpression} from './owned-room-capture.mjs';

// Shared exact-room recovery boundary. Never confuse Kakao's hidden autosizing
// textarea with an operator draft; unknown frames, attachments and real text block.
export async function refreshKakaoConversationWithoutDraft(target, {evaluateImpl, timeoutMs} = {}) {
  const url = new URL(target?.url);
  if (url.origin !== 'https://business.kakao.com' || !/^\/space\/[A-Za-z0-9_-]+\/channel\/_[A-Za-z0-9_-]+\/chats\/\d{6,24}\/?$/.test(url.pathname)) {
    throw new Error('Exact Kakao conversation target required');
  }
  return evaluateImpl(target, `(() => {
    const inspect = () => ${buildOwnedDraftInspectionExpression()};
    const state = inspect();
    if (state.href !== ${JSON.stringify(target.url)}) return { refreshed: false, reason: 'target_changed' };
    if (state.hasDraft !== false) return { refreshed: false, reason: 'unsent_draft_or_unknown' };
    setTimeout(() => {
      const latest = inspect();
      if (latest.href === ${JSON.stringify(target.url)} && latest.hasDraft === false) location.reload();
    }, 0);
    return { refreshed: true };
  })()`, {timeoutMs});
}
