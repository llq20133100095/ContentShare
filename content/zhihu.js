'use strict';

/**
 * 知乎写文章/发布页自动填充。
 * 若改版导致选择器失效，请用 DevTools 检查后更新 TITLE_SELECTORS / BODY_SELECTORS。
 */
const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'input[placeholder*="写下你的问题"]',
  'textarea[placeholder*="标题"]',
  '[contenteditable="true"][data-placeholder*="标题"]',
  '.WriteIndex-titleInput input',
  '.WriteIndex-titleInput textarea',
  'input[type="text"]'
];

const BODY_SELECTORS = [
  '.ProseMirror',
  '[contenteditable="true"]',
  '.ql-editor',
  'textarea[placeholder*="内容"]',
  'textarea[placeholder*="正文"]',
  '[role="textbox"]',
  'div[contenteditable]',
  'textarea'
];

function find(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && (el.offsetParent !== null || el === document.body)) return el;
    } catch (_) {}
  }
  return null;
}

function setInputValue(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setContentEditable(el, html) {
  el.innerHTML = html;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function fillTitle(title) {
  const el = find(TITLE_SELECTORS);
  if (!el) return false;
  if (el.contentEditable === 'true') setContentEditable(el, title);
  else setInputValue(el, title);
  return true;
}

function fillBody(bodyHtml) {
  const el = find(BODY_SELECTORS);
  if (!el) return false;
  const plain = document.createElement('div');
  plain.innerHTML = bodyHtml || '';
  const text = (plain.textContent || '').trim();
  if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') {
    setContentEditable(el, bodyHtml || text);
  } else {
    setInputValue(el, text);
  }
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FILL') return;
  try {
    const titleOk = fillTitle(msg.title || '');
    const bodyOk = fillBody(msg.bodyHtml || '');
    if (!titleOk && !bodyOk) {
      sendResponse({ success: false, error: '未找到标题或正文输入框，请确认当前为写文章/发布页；可尝试手动粘贴。' });
    } else {
      sendResponse({ success: true });
    }
  } catch (e) {
    sendResponse({ success: false, error: e?.message || '填充异常' });
  }
  return true;
});
