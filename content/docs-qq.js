'use strict';

/**
 * 从腾讯文档页面 DOM 提取标题、封面、正文。
 * 若页面改版，需在 docs.qq.com 用 DevTools 确认选择器后调整下方常量。
 */
const TITLE_SELECTORS = [
  '[class*="doc-title"]',
  '[class*="title"]',
  'h1',
  '.title'
];

const BODY_SELECTORS = [
  '[class*="doc-content"]',
  '[class*="document-content"]',
  '[class*="content"]',
  '[class*="editor"]',
  '[class*="doc-body"]',
  'main',
  'article',
  '.document-body',
  '#content',
  '.content'
];

function getText(el) {
  return el ? (el.textContent || '').trim() : '';
}

function findElement(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    } catch (_) {}
  }
  return null;
}

function findBodyContainer() {
  for (const sel of BODY_SELECTORS) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent || '').trim();
        if (text.length > 20) return el;
      }
    } catch (_) {}
  }
  return null;
}

function getTitle() {
  const titleEl = findElement(TITLE_SELECTORS);
  if (titleEl) return getText(titleEl);
  const t = document.title || '';
  if (t) return t.replace(/\s*[-|]\s*腾讯文档.*$/i, '').trim();
  return '';
}

function getCoverUrl(bodyEl) {
  const container = bodyEl || findBodyContainer() || document.body;
  const img = container.querySelector('img');
  return img && img.src ? img.src : '';
}

function sanitizeHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script, style, iframe').forEach((n) => n.remove());
  return div.innerHTML.trim();
}

function getBodyHtml() {
  const bodyEl = findBodyContainer();
  if (bodyEl) return sanitizeHtml(bodyEl.innerHTML);
  return sanitizeHtml(document.body.innerHTML);
}

function extract() {
  const bodyEl = findBodyContainer();
  const title = getTitle();
  const coverUrl = getCoverUrl(bodyEl);
  const bodyHtml = getBodyHtml();
  return { type: 'EXTRACT_RESULT', title, coverUrl, bodyHtml };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_CONTENT') return;
  try {
    setTimeout(() => {
      try {
        const result = extract();
        sendResponse(result);
      } catch (e) {
        sendResponse({ type: 'EXTRACT_ERROR', error: e?.message || '提取异常' });
      }
    }, 500);
  } catch (e) {
    sendResponse({ type: 'EXTRACT_ERROR', error: e?.message || '提取异常' });
  }
  return true;
});
