import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const displayInventory = `import AppKit
import CoreGraphics
import Foundation
let rows = NSScreen.screens.map { s -> [String:Any] in
  let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber).uint32Value
  let b = CGDisplayBounds(id), f = s.frame, v = s.visibleFrame
  return ["name":s.localizedName, "left":Int(b.minX + v.minX - f.minX),
    "top":Int(b.minY + f.maxY - v.maxY), "width":Int(v.width), "height":Int(v.height)]
}
print(String(data:try! JSONSerialization.data(withJSONObject:rows),encoding:.utf8)!)`;

export async function readAutomationDisplay() {
  if (process.platform !== 'darwin') throw Error('16MR70 display verification requires macOS');
  const { stdout } = await exec('/usr/bin/swift', ['-e', displayInventory], { timeout: 15000, maxBuffer: 16384 });
  return selectAutomationDisplay(JSON.parse(stdout));
}

export function selectAutomationDisplay(displays) {
  const matches = Array.isArray(displays) ? displays.filter(d => d.name === '16MR70') : [];
  if (matches.length !== 1) throw Error('16MR70 is unavailable or ambiguous; no other display will be used');
  const { left, top, width, height } = matches[0];
  if (![left, top, width, height].every(Number.isSafeInteger) || width < 400 || height < 300)
    throw Error('16MR70 bounds are invalid');
  return { left, top, width, height };
}

export function boundsWithin(actual, expected) {
  return actual && ['normal', 'maximized'].includes(actual.windowState)
    && [actual.left, actual.top, actual.width, actual.height].every(Number.isFinite)
    && actual.width > 0 && actual.height > 0
    && actual.left >= expected.left && actual.top >= expected.top
    && actual.left + actual.width <= expected.left + expected.width + 2
    && actual.top + actual.height <= expected.top + expected.height + 2;
}

// Keep task pages in the dedicated Chrome window. On macOS, repeatedly
// opening and closing a CDP background window can leave native windows alive
// even after the corresponding DevTools target is gone.
export async function createBackgroundTarget({ url, send, readDisplay = readAutomationDisplay, knownTargetIds = [], anchorTargetId }) {
  const bounds = await readDisplay();
  const before = await send('Target.getTargets', {});
  if (!Array.isArray(before.targetInfos)) throw Error('Background target ownership inventory is unavailable');
  const existing = new Set([...knownTargetIds, ...before.targetInfos.map(t => t.targetId)]);
  const pages = before.targetInfos.filter(target => target.type === 'page');
  const anchor = anchorTargetId
    ? pages.find(target => target.targetId === anchorTargetId)
    : pages.find(target => /^https:\/\/business\.kakao\.com\/[^?#]+\/chats\/?(?:[?#]|$)/.test(target.url)) || pages[0];
  if (!anchor) throw Error('The dedicated automation Chrome window is unavailable');
  const window = await send('Browser.getWindowForTarget', { targetId: anchor.targetId });
  if (!Number.isInteger(window.windowId) || !boundsWithin(window.bounds, bounds))
    throw Error('The dedicated automation Chrome window is outside 16MR70');
  const created = await send('Target.createTarget', {
    url, newWindow: false, background: true, focus: false
  });
  const targetId = created?.targetId;
  if (!targetId || existing.has(targetId)) throw Error('Background target ownership response is invalid or names an existing target');
  try {
    const targetWindow = await send('Browser.getWindowForTarget', { targetId });
    if (targetWindow.windowId !== window.windowId || !boundsWithin(targetWindow.bounds, bounds))
      throw Error('Background tab did not open in the dedicated automation Chrome window on 16MR70');
    return { targetId, windowId: window.windowId, bounds };
  } catch (error) {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    throw error;
  }
}

// Kakao's chat-list links use window.open(...). Keep that navigation in the
// task-owned list instead of creating a foreground popup on the user's display.
export function keepKakaoRoomInOwnedPage() {
  if (location.origin !== 'https://business.kakao.com') return;
  Object.defineProperty(window, 'focus', { value: () => {}, configurable: false, writable: false });
  if (!/\/chats\/?$/.test(location.pathname)) return;
  const open = (url) => {
    if (url && String(url) !== 'about:blank') window.location.assign(String(url));
    return window;
  };
  Object.defineProperty(window, 'open', { value: open, configurable: false, writable: false });
}

export async function openBackgroundPage(browser, context, url, options = {}) {
  const session = await browser.newBrowserCDPSession();
  const existing = new Set(context.pages());
  let targetId;
  try {
    ({ targetId } = await createBackgroundTarget({
      url: 'about:blank', send: (method, params) => session.send(method, params), ...options
    }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const page of context.pages().filter(p => !existing.has(p))) {
        const targetSession = await context.newCDPSession(page);
        let info;
        try { info = await targetSession.send('Target.getTargetInfo'); }
        finally { await targetSession.detach(); }
        if (info.targetInfo?.targetId === targetId) {
          await page.addInitScript(keepKakaoRoomInOwnedPage);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          return page;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Task-owned background page was not available');
  } catch (error) {
    if (targetId) await session.send('Target.closeTarget', { targetId }).catch(() => {});
    throw error;
  } finally { await session.detach(); }
}
