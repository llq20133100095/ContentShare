'use strict';

// 点击扩展图标打开独立内容分发页（新标签页）
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dist.html') });
});

// 消息路由：分发页 → background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXTRACT') {
    handleExtract(message.url, sendResponse);
    return true;
  }
  if (message.type === 'CONVERT_IMAGES') {
    handleConvertImages(message.urls, message.sourceDocUrl, sendResponse);
    return true;
  }
  if (message.type === 'AUTO_IMPORT_DOC_IMAGES') {
    handleAutoImportDocImages(message.sourceDocUrl, message.imageUrls, sendResponse);
    return true;
  }
  if (message.type === 'SYNC') {
    handleSync(message, sendResponse);
    return true;
  }
});

// ─── 工具函数 ────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('页面加载超时'));
      }
    }, timeoutMs);

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);

    // 可能已经 complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') done();
    });
  });
}

// ─── 知乎图片上传（在 service worker 中执行，不受页面限制） ─────

/**
 * 将 data-URL 转为 Blob（service worker 中可用）
 */
function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  if (!mimeMatch) return null;
  const mime = mimeMatch[1];
  const bstr = atob(arr[1]);
  const u8 = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

/**
 * 从 cookies 读取知乎 _xsrf token
 */
async function getZhihuXsrfFromCookie() {
  try {
    const c = await chrome.cookies.get({ url: 'https://zhuanlan.zhihu.com', name: '_xsrf' });
    return c ? c.value : '';
  } catch (_) {
    return '';
  }
}

/**
 * 压缩图片以适配知乎版面（OffscreenCanvas，service worker 可用）
 * 知乎文章区宽 690px，Retina 2x = 1380px；保持高清
 */
const ZHIHU_IMG_MAX_W = 1380;
const ZHIHU_IMG_MAX_H = 2000;
const ZHIHU_JPEG_QUALITY = 0.88;

async function compressImageForZhihu(blob) {
  const tag = '[图片压缩]';
  const origSize = blob.size;
  console.log(`${tag} 原始: ${(origSize / 1024).toFixed(1)}KB, type=${blob.type}`);

  try {
    const bmp = await createImageBitmap(blob);
    let w = bmp.width;
    let h = bmp.height;
    console.log(`${tag} 原始尺寸: ${w}x${h}`);

    // 等比缩放
    if (w > ZHIHU_IMG_MAX_W) {
      h = Math.round(h * ZHIHU_IMG_MAX_W / w);
      w = ZHIHU_IMG_MAX_W;
    }
    if (h > ZHIHU_IMG_MAX_H) {
      w = Math.round(w * ZHIHU_IMG_MAX_H / h);
      h = ZHIHU_IMG_MAX_H;
    }
    console.log(`${tag} 目标尺寸: ${w}x${h}`);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();

    const compressed = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: ZHIHU_JPEG_QUALITY,
    });

    console.log(`${tag} 压缩后: ${(compressed.size / 1024).toFixed(1)}KB (${Math.round(compressed.size / origSize * 100)}%)`);
    // 只在确实变小时使用压缩版本
    return compressed.size < origSize ? compressed : blob;
  } catch (err) {
    console.error(`${tag} 压缩失败，使用原图:`, err);
    return blob;
  }
}

/**
 * 上传单张图片到知乎 CDN，返回图片 URL；失败返回 null
 */
async function uploadSingleImageToZhihu(blob, filename) {
  const xsrf = await getZhihuXsrfFromCookie();

  // 端点 + 字段名组合
  const attempts = [
    { url: 'https://zhuanlan.zhihu.com/api/uploaded_images', field: 'file' },
    { url: 'https://zhuanlan.zhihu.com/api/uploaded_images', field: 'picture' },
    { url: 'https://api.zhihu.com/images', field: 'file', extra: { source: 'article' } },
  ];

  const tag = '[知乎上传]';
  console.log(`${tag} 开始上传 ${filename}, ${(blob.size / 1024).toFixed(1)}KB, xsrf=${xsrf ? '有' : '无'}`);

  for (const att of attempts) {
    try {
      const fd = new FormData();
      fd.append(att.field, blob, filename);
      if (att.extra) {
        for (const [k, v] of Object.entries(att.extra)) fd.append(k, v);
      }

      const headers = {};
      if (xsrf) headers['x-xsrftoken'] = xsrf;

      console.log(`${tag} 尝试 ${att.url} (field=${att.field})`);
      const resp = await fetch(att.url, {
        method: 'POST',
        headers,
        body: fd,
        credentials: 'include',
      });

      console.log(`${tag} 响应: ${resp.status} ${resp.statusText}`);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`${tag} 失败内容: ${errText.substring(0, 200)}`);
        continue;
      }
      const data = await resp.json();
      console.log(`${tag} 返回数据:`, JSON.stringify(data).substring(0, 300));

      // 直接返回 URL
      const url = data.src || data.url || data.original_src || data.watermark_src || '';
      if (url) { console.log(`${tag} ✅ 成功: ${url}`); return url; }

      // 如果返回 image_id（图片已存在），再查询一次
      const imgId = data.upload_file?.image_id || data.image_id;
      if (imgId) {
        console.log(`${tag} 图片已存在, image_id=${imgId}, 查询 URL...`);
        try {
          const r2 = await fetch('https://api.zhihu.com/images/' + imgId, { credentials: 'include' });
          if (r2.ok) {
            const d2 = await r2.json();
            const u2 = d2.original_src || d2.src || d2.url || '';
            if (u2) { console.log(`${tag} ✅ 查询成功: ${u2}`); return u2; }
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error(`${tag} 端点异常:`, err);
    }
  }
  console.warn(`${tag} ❌ 所有端点均失败`);
  return null;
}

/**
 * 把 bodyHtml 中所有 data-URL 图片上传到知乎 CDN，返回替换后的 HTML
 */
async function uploadAllImagesToZhihu(bodyHtml) {
  // 用正则提取所有 <img ... src="data:image/..."> 
  const imgTagRe = /(<img\b[^>]*?\bsrc=["'])(data:image\/[^"']+)(["'][^>]*?>)/gi;
  const matches = [];
  let m;
  while ((m = imgTagRe.exec(bodyHtml)) !== null) {
    matches.push({ fullMatch: m[0], prefix: m[1], dataUrl: m[2], suffix: m[3], index: m.index });
  }

  if (matches.length === 0) return bodyHtml;

  let uploadedCount = 0;
  // 从后往前替换，避免 index 偏移
  for (let i = matches.length - 1; i >= 0; i--) {
    const mt = matches[i];
    try {
      const rawBlob = dataUrlToBlob(mt.dataUrl);
      if (!rawBlob) continue;
      // 压缩以适配知乎版面，同时保持清晰度
      const blob = await compressImageForZhihu(rawBlob);
      const ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
      const cdnUrl = await uploadSingleImageToZhihu(blob, `image${i}.${ext}`);
      if (cdnUrl) {
        const newTag = mt.prefix + cdnUrl + mt.suffix;
        bodyHtml = bodyHtml.substring(0, mt.index) + newTag + bodyHtml.substring(mt.index + mt.fullMatch.length);
        uploadedCount++;
      }
    } catch (_) {}
  }

  console.log(`[ContentShare] 知乎图片上传: ${uploadedCount}/${matches.length} 张成功`);
  return bodyHtml;
}

// ─── 提取：在目标页直接执行函数，无需 content script 消息 ─────

/**
 * 注入到 docs.qq.com 页面执行的提取函数（必须完全自包含，不能引用外部变量）
 * 返回 Promise — chrome.scripting.executeScript 会自动 await
 */
async function extractFromDocsQQ() {
  const TITLE_SELECTORS = [
    '[class*="doc-title"]',
    '[class*="allInOne-title"]',
    '[class*="aio-title"]',
    'h1[class*="title"]',
    '.header-title',
    'h1',
    '[class*="title"]'
  ];

  const BODY_SELECTORS = [
    '[class*="doc-content"]',
    '[class*="allInOne-content"]',
    '[class*="aio-content"]',
    '[class*="document-content"]',
    '[class*="read-only"]',
    '[class*="editor-content"]',
    '[class*="ql-editor"]',
    '[class*="ProseMirror"]',
    '[contenteditable]',
    'main',
    'article',
    '[class*="content"]',
    '[class*="editor"]',
    '[class*="doc-body"]'
  ];

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getText(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  function findTitle() {
    for (const sel of TITLE_SELECTORS) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = getText(el);
          if (text && text.length > 0 && text.length < 200) return text;
        }
      } catch (_) {}
    }
    const t = document.title || '';
    return t.replace(/\s*[-|–—]\s*(腾讯文档|QQ文档|docs\.qq\.com).*$/i, '').trim();
  }

  function findBodyContainer() {
    let best = null;
    let bestScore = -1;
    for (const sel of BODY_SELECTORS) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;
          const textLen = (el.textContent || '').trim().length;
          const imgCount = el.querySelectorAll('img,canvas,[style*="background-image"]').length;
          const rect = el.getBoundingClientRect();
          const area = Math.max(0, rect.width * rect.height);
          const score = textLen + imgCount * 800 + Math.min(area / 500, 5000);
          if (score > bestScore && textLen > 20) {
            bestScore = score;
            best = el;
          }
        }
      } catch (_) {}
    }
    return best;
  }

  function resolveImgSrc(img) {
    return img.getAttribute('src')
      || img.getAttribute('data-src')
      || img.getAttribute('data-original')
      || img.getAttribute('data-origin')
      || img.getAttribute('data-actualsrc')
      || img.currentSrc
      || img.src
      || '';
  }

  async function toDataUrlFromFetch(src) {
    try {
      const resp = await fetch(src, { credentials: 'include' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (_) {
      return null;
    }
  }

  function toDataUrlFromCanvasDrawable(drawable, w, h) {
    try {
      if (!w || !h) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(drawable, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  }

  async function ensureImagesLoadedAndInline(container) {
    if (!container) return;

    // 1) 触发懒加载：滚动容器 + 页面
    const scrollable = container.scrollHeight > container.clientHeight + 50;
    if (scrollable) {
      const max = container.scrollHeight;
      const step = Math.max(300, Math.floor(container.clientHeight * 0.8));
      for (let y = 0; y < max; y += step) {
        container.scrollTop = y;
        await wait(180);
      }
      container.scrollTop = 0;
    }
    const docMax = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const viewport = window.innerHeight || 800;
    for (let y = 0; y < docMax; y += Math.max(400, Math.floor(viewport * 0.9))) {
      window.scrollTo(0, y);
      await wait(120);
    }
    window.scrollTo(0, 0);
    await wait(300);

    // 2) img: 懒加载属性补全 + base64 化
    const imgs = Array.from(container.querySelectorAll('img'));
    for (const img of imgs) {
      const src = resolveImgSrc(img);
      if (!src) continue;
      if (src.startsWith('data:')) continue;
      if (!img.getAttribute('src') && src) img.setAttribute('src', src);
      if (!img.complete) {
        await Promise.race([
          new Promise((resolve) => img.addEventListener('load', resolve, { once: true })),
          wait(1500)
        ]);
      }

      let dataUrl = null;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        dataUrl = toDataUrlFromCanvasDrawable(img, img.naturalWidth, img.naturalHeight);
      }
      if (!dataUrl) {
        dataUrl = await toDataUrlFromFetch(src);
      }
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
        img.removeAttribute('srcset');
        img.removeAttribute('loading');
        img.removeAttribute('data-src');
        img.removeAttribute('data-original');
        img.removeAttribute('data-origin');
        img.removeAttribute('data-actualsrc');
      }
    }

    // 3) canvas: 导出为 img
    const canvases = Array.from(container.querySelectorAll('canvas'));
    for (const cvs of canvases) {
      let dataUrl = null;
      try {
        dataUrl = cvs.toDataURL('image/png');
      } catch (_) {
        dataUrl = null;
      }
      if (!dataUrl) continue;
      const img = document.createElement('img');
      img.src = dataUrl;
      const rect = cvs.getBoundingClientRect();
      if (rect.width > 0) img.style.width = `${Math.round(rect.width)}px`;
      if (rect.height > 0) img.style.height = `${Math.round(rect.height)}px`;
      cvs.replaceWith(img);
    }

    // 4) background-image: 提取 computedStyle 的 url
    const all = Array.from(container.querySelectorAll('*'));
    for (const el of all) {
      const bg = getComputedStyle(el).backgroundImage || '';
      if (!bg || bg === 'none') continue;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !m[1]) continue;
      const src = m[1];
      let dataUrl = src.startsWith('data:') ? src : await toDataUrlFromFetch(src);
      if (!dataUrl) continue;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.style.maxWidth = '100%';
      img.style.display = 'block';
      img.style.margin = '8px 0';
      el.style.backgroundImage = 'none';
      el.prepend(img);
    }
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('script, style, iframe, link, meta, noscript').forEach((n) => n.remove());
    div.querySelectorAll('*').forEach((el) => {
      el.removeAttribute('data-record-id');
      el.removeAttribute('data-block-id');
      el.removeAttribute('data-reactid');
    });
    return div.innerHTML.trim();
  }

  function normalizePossibleImgUrl(url) {
    if (!url) return '';
    let u = url.trim().replace(/^["']|["']$/g, '');
    if (!u) return '';
    if (u.startsWith('//')) u = `https:${u}`;
    if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
    return u;
  }

  function collectImageUrlsFromDom(root) {
    const out = new Set();
    if (!root) return out;

    // 1) img 常见属性
    const imgs = root.querySelectorAll('img');
    for (const img of imgs) {
      const cand = [
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-origin'),
        img.getAttribute('data-actualsrc'),
        img.currentSrc,
        img.src
      ];
      for (const c of cand) {
        const u = normalizePossibleImgUrl(c || '');
        if (u) out.add(u);
      }
    }

    // 2) 任意元素上可能存的 URL 属性
    const attrs = ['src', 'data-src', 'data-original', 'data-origin', 'data-actualsrc', 'href'];
    const all = root.querySelectorAll('*');
    for (const el of all) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const u = normalizePossibleImgUrl(v);
        if (u) out.add(u);
      }
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) {
        const u = normalizePossibleImgUrl(m[1]);
        if (u) out.add(u);
      }
    }
    return out;
  }

  function collectImageUrlsFromHtmlSource(html) {
    const out = new Set();
    if (!html) return out;
    const regex = /https?:\/\/[^"'<>\s]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^"'<>\s]*)?/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const u = normalizePossibleImgUrl(m[0]);
      if (u) out.add(u);
    }
    return out;
  }

  function isLikelyContentImage(url) {
    const u = (url || '').toLowerCase();
    if (!u) return false;
    if (u.startsWith('data:')) return true;
    if (!u.startsWith('https://') && !u.startsWith('http://') && !u.startsWith('blob:')) return false;
    if (u.includes('icon') || u.includes('avatar') || u.includes('logo') || u.includes('emoji')) return false;
    return true;
  }

  const bodyEl = findBodyContainer();
  let bodyHtml = '';
  let coverUrl = '';

  if (bodyEl) {
    await ensureImagesLoadedAndInline(bodyEl);
    bodyHtml = sanitizeHtml(bodyEl.innerHTML);
    const coverImg = bodyEl.querySelector('img[src^="data:"], img[src^="http"]');
    if (coverImg) coverUrl = coverImg.getAttribute('src') || '';
  }

  // 兜底：正文容器中若没有图片，则尝试整页提取（腾讯文档常见图片块与文本块分离渲染）
  const hasImgInBody = /<img[\s>]/i.test(bodyHtml);
  if (!hasImgInBody) {
    await ensureImagesLoadedAndInline(document.body);
    const fullHtml = sanitizeHtml(document.body.innerHTML);
    if (/<img[\s>]/i.test(fullHtml)) {
      bodyHtml = fullHtml;
      if (!coverUrl) {
        const temp = document.createElement('div');
        temp.innerHTML = fullHtml;
        const firstImg = temp.querySelector('img[src^="data:"], img[src^="http"]');
        if (firstImg) coverUrl = firstImg.getAttribute('src') || '';
      }
    }
  }

  // 强兜底：如果还是没有图片标签，则直接扫描图片 URL 并拼装到正文尾部
  if (!/<img[\s>]/i.test(bodyHtml)) {
    const fromDom = collectImageUrlsFromDom(document.body);
    const fromSrc = collectImageUrlsFromHtmlSource(document.documentElement?.outerHTML || '');
    const merged = new Set([...fromDom, ...fromSrc]);
    const imageUrls = Array.from(merged).filter(isLikelyContentImage).slice(0, 20);
    if (imageUrls.length > 0) {
      const fallbackGallery = imageUrls
        .map((u) => `<p><img src="${u.replace(/"/g, '&quot;')}" /></p>`)
        .join('');
      bodyHtml = `${bodyHtml || '<p></p>'}<hr/><p>图片提取兜底结果：</p>${fallbackGallery}`;
      if (!coverUrl) coverUrl = imageUrls[0];
    }
  }

  return {
    type: 'EXTRACT_RESULT',
    title: findTitle(),
    coverUrl,
    bodyHtml,
    _debug: {
      hasBody: !!bodyEl,
      bodyTextLen: bodyEl ? (bodyEl.textContent || '').length : 0,
      imgCount: bodyEl ? bodyEl.querySelectorAll('img').length : 0,
      canvasCount: bodyEl ? bodyEl.querySelectorAll('canvas').length : 0,
      bodyHasImgTag: /<img[\s>]/i.test(bodyHtml),
      fallbackImgScanHit: (() => {
        const c = bodyHtml.match(/<img[\s>]/gi);
        return c ? c.length : 0;
      })(),
      url: location.href
    }
  };
}

async function handleExtract(url, sendResponse) {
  try {
    // 截图方案需要目标页处于可见激活状态
    const tab = await new Promise((resolve) => {
      chrome.tabs.create({ url, active: true }, resolve);
    });

    if (!tab?.id) {
      sendResponse({ type: 'EXTRACT_ERROR', error: '无法创建标签页' });
      return;
    }

    await waitForTabComplete(tab.id);
    try {
      await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, resolve));
      await new Promise((resolve) => chrome.tabs.update(tab.id, { active: true }, resolve));
    } catch (_) {}

    // 腾讯文档是重 SPA，加载 complete 后内容可能还没渲染
    // 使用重试机制：等待 → 注入提取 → 检查结果 → 如果内容太少则重试
    const MAX_RETRIES = 4;
    const WAIT_TIMES = [3000, 4000, 5000, 6000]; // 逐次递增

    let lastResult = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      await sleep(WAIT_TIMES[i]);

      try {
        const frameResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: extractFromDocsQQ
        });

        if (frameResults && frameResults.length > 0) {
          // 选择最优 frame：优先有图片，其次正文更长
          const candidates = frameResults
            .map((f) => f.result)
            .filter(Boolean);
          if (candidates.length > 0) {
            candidates.sort((a, b) => {
              const aHasImg = a._debug?.bodyHasImgTag ? 1 : 0;
              const bHasImg = b._debug?.bodyHasImgTag ? 1 : 0;
              if (aHasImg !== bHasImg) return bHasImg - aHasImg;
              const aLen = a._debug?.bodyTextLen || 0;
              const bLen = b._debug?.bodyTextLen || 0;
              return bLen - aLen;
            });
            lastResult = candidates[0];
            const bodyLen = lastResult._debug?.bodyTextLen || 0;
            if (bodyLen > 50) {
              // 新方案：无论是否提取到 DOM 图片，都附加“分屏截图”兜底
              const shots = await captureDocScreenshots(tab.id, tab.windowId);
              if (shots.length > 0) {
                lastResult.bodyHtml = appendScreenshotGallery(lastResult.bodyHtml, shots);
                if (!lastResult.coverUrl) lastResult.coverUrl = shots[0];
                if (lastResult._debug) {
                  lastResult._debug.screenshotCount = shots.length;
                }
              }
              sendResponse(lastResult);
              return;
            }
          }
        }
      } catch (e) {
        // executeScript 失败，重试
      }
    }

    // 重试完毕，返回最后一次结果
    if (lastResult) {
      if (lastResult.bodyHtml || lastResult.title) {
        const shots = await captureDocScreenshots(tab.id, tab.windowId);
        if (shots.length > 0) {
          lastResult.bodyHtml = appendScreenshotGallery(lastResult.bodyHtml, shots);
          if (!lastResult.coverUrl) lastResult.coverUrl = shots[0];
          if (lastResult._debug) {
            lastResult._debug.screenshotCount = shots.length;
          }
        }
        sendResponse(lastResult);
      } else {
        // 即便正文为空，也尝试返回截图内容
        const shots = await captureDocScreenshots(tab.id, tab.windowId);
        if (shots.length > 0) {
          sendResponse({
            type: 'EXTRACT_RESULT',
            title: lastResult.title || '',
            coverUrl: shots[0],
            bodyHtml: appendScreenshotGallery('<p>未提取到结构化正文，已附加页面截图：</p>', shots),
            _debug: { screenshotCount: shots.length, fallback: 'screenshot_only' }
          });
        } else {
          sendResponse({
            type: 'EXTRACT_ERROR',
            error: '页面内容为空，且截图失败。可能文档需要登录、链接无效、或浏览器权限限制。'
          });
        }
      }
    } else {
      const shots = await captureDocScreenshots(tab.id, tab.windowId);
      if (shots.length > 0) {
        sendResponse({
          type: 'EXTRACT_RESULT',
          title: '',
          coverUrl: shots[0],
          bodyHtml: appendScreenshotGallery('<p>未提取到结构化正文，已附加页面截图：</p>', shots),
          _debug: { screenshotCount: shots.length, fallback: 'screenshot_only' }
        });
      } else {
        sendResponse({ type: 'EXTRACT_ERROR', error: '多次尝试后仍无法提取内容，且截图失败' });
      }
    }
  } catch (err) {
    sendResponse({ type: 'EXTRACT_ERROR', error: err?.message || '提取失败' });
  }
}

async function captureDocScreenshots(tabId, windowId) {
  try {
    // 读取页面高度和视口高度
    const metricsRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const doc = document.documentElement;
        const body = document.body;
        const total = Math.max(
          doc?.scrollHeight || 0,
          body?.scrollHeight || 0,
          doc?.offsetHeight || 0,
          body?.offsetHeight || 0
        );
        const viewport = window.innerHeight || doc?.clientHeight || 800;
        return { total, viewport };
      }
    });
    const metrics = metricsRes?.[0]?.result || { total: 0, viewport: 800 };
    const total = Math.max(metrics.total || 0, 0);
    const viewport = Math.max(metrics.viewport || 800, 400);
    const step = Math.floor(viewport * 0.9);
    const maxShots = 5;
    const targets = [];
    for (let y = 0; y < total && targets.length < maxShots; y += step) {
      targets.push(y);
    }
    if (targets.length === 0) targets.push(0);

    const images = [];
    for (const y of targets) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (top) => {
          window.scrollTo(0, top);
        },
        args: [y]
      });
      await sleep(450);
      const dataUrl = await new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }, (img) => {
          if (chrome.runtime.lastError) resolve('');
          else resolve(img || '');
        });
      });
      if (dataUrl) images.push(dataUrl);
    }

    // 恢复顶部
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollTo(0, 0)
    });
    return images;
  } catch (_) {
    return [];
  }
}

function appendScreenshotGallery(bodyHtml, screenshots) {
  const safe = bodyHtml || '<p></p>';
  if (!screenshots || screenshots.length === 0) return safe;
  const gallery = screenshots
    .map((src, idx) => `<p>截图 ${idx + 1}</p><p><img src="${src}" /></p>`)
    .join('');
  return `${safe}<hr/><p>页面截图兜底：</p>${gallery}`;
}

async function getOrCreateDocsTab(sourceDocUrl) {
  const prefer = typeof sourceDocUrl === 'string' ? sourceDocUrl.trim() : '';
  if (prefer && prefer.startsWith('https://docs.qq.com/')) {
    const exact = await new Promise((resolve) => {
      chrome.tabs.query({ url: prefer }, resolve);
    });
    if (exact && exact.length > 0) return exact[0];
    const tab = await new Promise((resolve) => {
      chrome.tabs.create({ url: prefer, active: false }, resolve);
    });
    if (tab?.id) {
      await waitForTabComplete(tab.id);
      await sleep(1200);
    }
    return tab;
  }

  const exist = await new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://docs.qq.com/*' }, resolve);
  });
  if (exist && exist.length > 0) return exist[0];
  const tab = await new Promise((resolve) => {
    chrome.tabs.create({ url: 'https://docs.qq.com/', active: false }, resolve);
  });
  if (tab?.id) {
    await waitForTabComplete(tab.id);
    await sleep(1200);
  }
  return tab;
}

async function handleConvertImages(urls, sourceDocUrl, sendResponse) {
  try {
    const list = Array.isArray(urls) ? urls.filter(Boolean).slice(0, 12) : [];
    if (list.length === 0) {
      sendResponse({ type: 'CONVERT_IMAGES_RESULT', results: {} });
      return;
    }

    const tab = await getOrCreateDocsTab(sourceDocUrl);
    if (!tab?.id) {
      sendResponse({ type: 'CONVERT_IMAGES_RESULT', results: {} });
      return;
    }

    const exec = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (inputUrls) => {
        async function blobToDataUrl(blob) {
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }

        const out = {};
        for (const raw of inputUrls) {
          const url = String(raw || '').trim();
          if (!url) continue;
          try {
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) {
              out[url] = null;
              continue;
            }
            const blob = await resp.blob();
            const dataUrl = await blobToDataUrl(blob);
            out[url] = dataUrl && dataUrl.startsWith('data:') ? dataUrl : null;
          } catch (_) {
            out[url] = null;
          }
        }
        return out;
      },
      args: [list]
    });

    const results = exec?.[0]?.result || {};

    // 第三级：不依赖 docimg 直链，直接从“文档页已渲染图片”提取 dataURL
    const failed = list.filter((u) => !results[u]);
    if (failed.length > 0) {
      const rendered = await extractRenderedImagesFromDocTab(tab.id);
      const mapped = mapFailedUrlsToRenderedImages(failed, rendered);
      for (const url of failed) {
        if (mapped[url]) {
          results[url] = mapped[url];
        }
      }
    }

    sendResponse({ type: 'CONVERT_IMAGES_RESULT', results });
  } catch (_) {
    sendResponse({ type: 'CONVERT_IMAGES_RESULT', results: {} });
  }
}

async function extractRenderedImagesFromDocTab(tabId) {
  try {
    const exec = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        function normalize(url) {
          try {
            const u = new URL(url, location.href);
            return `${u.origin}${u.pathname}`;
          } catch (_) {
            return String(url || '').split('?')[0].split('#')[0];
          }
        }

        function parseWH(url) {
          try {
            const u = new URL(url, location.href);
            const w = Number(u.searchParams.get('w') || 0);
            const h = Number(u.searchParams.get('h') || 0);
            return { w, h };
          } catch (_) {
            return { w: 0, h: 0 };
          }
        }

        async function blobToDataUrl(blob) {
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          });
        }

        // 懒加载触发：滚动文档页面，确保图片节点渲染
        try {
          const total = Math.max(
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0
          );
          const viewport = window.innerHeight || 800;
          const step = Math.max(300, Math.floor(viewport * 0.9));
          for (let y = 0; y < total; y += step) {
            window.scrollTo(0, y);
            await wait(120);
          }
          window.scrollTo(0, 0);
          await wait(250);
        } catch (_) {}

        const imgs = Array.from(document.querySelectorAll('img')).filter((img) => {
          const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
          if (!src) return false;
          if (img.naturalWidth < 40 || img.naturalHeight < 40) return false;
          return true;
        });

        const out = [];
        for (const img of imgs.slice(0, 80)) {
          const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
          const normalized = normalize(src);
          const { w, h } = parseWH(src);
          let dataUrl = '';

          // 优先 fetch（利用文档页上下文和登录态）
          try {
            const resp = await fetch(src, { credentials: 'include' });
            if (resp.ok) {
              const blob = await resp.blob();
              dataUrl = await blobToDataUrl(blob);
            }
          } catch (_) {}

          // fetch 失败再尝试 canvas
          if (!dataUrl) {
            try {
              if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                dataUrl = canvas.toDataURL('image/png');
              }
            } catch (_) {}
          }

          if (dataUrl && dataUrl.startsWith('data:')) {
            out.push({
              src,
              normalized,
              dataUrl,
              width: img.naturalWidth || 0,
              height: img.naturalHeight || 0,
              queryW: w,
              queryH: h
            });
          }
        }
        return out;
      }
    });

    const merged = [];
    for (const frame of exec || []) {
      const arr = Array.isArray(frame.result) ? frame.result : [];
      merged.push(...arr);
    }

    // 去重（按 normalized + 尺寸）
    const map = new Map();
    for (const item of merged) {
      const key = `${item.normalized}|${item.width}x${item.height}`;
      if (!map.has(key)) map.set(key, item);
    }
    return Array.from(map.values());
  } catch (_) {
    return [];
  }
}

function mapFailedUrlsToRenderedImages(failedUrls, renderedImages) {
  function normalize(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return String(url || '').split('?')[0].split('#')[0];
    }
  }

  function parseWH(url) {
    try {
      const u = new URL(url);
      return {
        w: Number(u.searchParams.get('w') || 0),
        h: Number(u.searchParams.get('h') || 0)
      };
    } catch (_) {
      return { w: 0, h: 0 };
    }
  }

  const result = {};
  const used = new Set();

  for (const url of failedUrls) {
    const n = normalize(url);
    const wh = parseWH(url);

    // 1) URL 精确/包含匹配
    let candidate = renderedImages.find((img, idx) => {
      if (used.has(idx)) return false;
      return img.normalized === n || img.src.includes(n) || n.includes(img.normalized);
    });

    // 2) 尺寸匹配（常见 w/h 参数）
    if (!candidate && wh.w > 0 && wh.h > 0) {
      let bestIdx = -1;
      let bestScore = Number.MAX_SAFE_INTEGER;
      renderedImages.forEach((img, idx) => {
        if (used.has(idx)) return;
        const iw = img.width || img.queryW || 0;
        const ih = img.height || img.queryH || 0;
        if (!iw || !ih) return;
        const score = Math.abs(iw - wh.w) + Math.abs(ih - wh.h);
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      });
      if (bestIdx >= 0 && bestScore < 80) {
        candidate = renderedImages[bestIdx];
        used.add(bestIdx);
      }
    }

    // 3) 兜底按顺序补
    if (!candidate) {
      const idx = renderedImages.findIndex((_, i) => !used.has(i));
      if (idx >= 0) {
        candidate = renderedImages[idx];
        used.add(idx);
      }
    } else {
      const idx = renderedImages.indexOf(candidate);
      if (idx >= 0) used.add(idx);
    }

    if (candidate?.dataUrl) {
      result[url] = candidate.dataUrl;
    }
  }

  return result;
}

async function handleAutoImportDocImages(sourceDocUrl, imageUrls, sendResponse) {
  try {
    const source = typeof sourceDocUrl === 'string' ? sourceDocUrl.trim() : '';
    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean).slice(0, 30) : [];
    if (!source.startsWith('https://docs.qq.com/') || urls.length === 0) {
      sendResponse({ type: 'AUTO_IMPORT_DOC_IMAGES_RESULT', results: {} });
      return;
    }

    const tab = await getOrCreateDocsTab(source);
    if (!tab?.id) {
      sendResponse({ type: 'AUTO_IMPORT_DOC_IMAGES_RESULT', results: {} });
      return;
    }
    await waitForTabComplete(tab.id);
    await sleep(1200);

    const rendered = await extractRenderedImagesFromDocTab(tab.id);
    const byMatch = mapFailedUrlsToRenderedImages(urls, rendered);

    // 补齐：按顺序填充剩余项
    const normalizedRendered = rendered
      .map((r) => r?.dataUrl)
      .filter((v) => typeof v === 'string' && v.startsWith('data:image/'));
    let cursor = 0;
    for (const url of urls) {
      if (byMatch[url]) continue;
      while (cursor < normalizedRendered.length && Object.values(byMatch).includes(normalizedRendered[cursor])) {
        cursor += 1;
      }
      if (cursor < normalizedRendered.length) {
        byMatch[url] = normalizedRendered[cursor];
        cursor += 1;
      }
    }

    sendResponse({ type: 'AUTO_IMPORT_DOC_IMAGES_RESULT', results: byMatch });
  } catch (_) {
    sendResponse({ type: 'AUTO_IMPORT_DOC_IMAGES_RESULT', results: {} });
  }
}

// ─── 同步：注入填充函数到目标平台页面 ─────────────────────

const PLATFORM_URLS = {
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  zhihu: 'https://zhuanlan.zhihu.com/write',
  tencentcloud: 'https://cloud.tencent.com/developer/article/write-new'
};

/**
 * 注入到小红书创作者平台的填充函数
 */
/**
 * 知乎图片上传函数（在 ISOLATED world 运行 — 内容脚本的默认环境）
 *
 * 关键原理：Chrome 内容脚本对同源请求（如 /api/uploaded_images）
 * 会使用页面的 Origin（https://zhuanlan.zhihu.com）和 Cookie，
 * 而非扩展的 Origin。这解决了之前 service worker 和 MAIN world
 * 方案中 403 被拒绝的问题。
 *
 * 流程：data:image → 压缩 → 上传到知乎 CDN → 替换 HTML 中的 URL
 */
async function zhihuUploadImages(bodyHtml) {
  const MAX_W = 1380, MAX_H = 2000, JPEG_Q = 0.88;
  const tag = '[知乎图片上传]';

  /* ── data-URL → Blob ── */
  function dataUrlToBlob(dataUrl) {
    try {
      const arr = dataUrl.split(',');
      const m = arr[0].match(/:(.*?);/);
      if (!m) return null;
      const bstr = atob(arr[1]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      return new Blob([u8], { type: m[1] });
    } catch (_) { return null; }
  }

  /* ── 压缩图片（OffscreenCanvas 优先，回退为 Canvas） ── */
  async function compressImage(blob) {
    const origSize = blob.size;
    try {
      const bmp = await createImageBitmap(blob);
      let w = bmp.width, h = bmp.height;
      console.log(`${tag} 原始尺寸: ${w}x${h}, ${(origSize/1024).toFixed(1)}KB`);
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
      if (h > MAX_H) { w = Math.round(w * MAX_H / h); h = MAX_H; }
      console.log(`${tag} 目标尺寸: ${w}x${h}`);

      // 优先 OffscreenCanvas（部分浏览器可能不支持）
      try {
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const compressed = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_Q });
        console.log(`${tag} 压缩: ${(compressed.size/1024).toFixed(1)}KB (${Math.round(compressed.size/origSize*100)}%)`);
        return compressed.size < origSize ? compressed : blob;
      } catch (_) {
        // 回退为 DOM Canvas
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
        URL.revokeObjectURL(url);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        bmp.close();
        const compressed = await new Promise(ok => c.toBlob(ok, 'image/jpeg', JPEG_Q));
        console.log(`${tag} 压缩(canvas): ${(compressed.size/1024).toFixed(1)}KB`);
        return compressed.size < origSize ? compressed : blob;
      }
    } catch (e) {
      console.warn(`${tag} 压缩失败，用原图:`, e);
      return blob;
    }
  }

  /* ── 读取 _xsrf CSRF token ── */
  function getXsrf() {
    const m = (document.cookie || '').match(/(?:^|;\s*)_xsrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ── 上传单张图片到知乎 CDN ── */
  async function uploadOne(blob, name) {
    const xsrf = getXsrf();
    console.log(`${tag} 上传 ${name}, ${(blob.size/1024).toFixed(1)}KB, xsrf=${xsrf?'有':'无'}`);

    // 同源端点（内容脚本的 fetch 自动使用页面 Origin 和 Cookie）
    const endpoints = [
      { url: '/api/uploaded_images', field: 'file' },
      { url: '/api/uploaded_images', field: 'picture' },
    ];

    for (const ep of endpoints) {
      try {
        const fd = new FormData();
        fd.append(ep.field, blob, name);

        const headers = { 'x-requested-with': 'XMLHttpRequest' };
        if (xsrf) headers['x-xsrftoken'] = xsrf;

        console.log(`${tag} → ${ep.url} (field=${ep.field})`);
        const resp = await fetch(ep.url, {
          method: 'POST',
          headers,
          body: fd,
          credentials: 'same-origin',
        });

        console.log(`${tag} 响应: ${resp.status} ${resp.statusText}`);
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.warn(`${tag} 错误: ${errText.substring(0, 300)}`);
          continue;
        }

        const data = await resp.json();
        console.log(`${tag} 数据:`, JSON.stringify(data).substring(0, 400));

        // 直接返回 URL（不同 API 版本字段名不同）
        const url = data.src || data.url || data.original_src || data.watermark_src || '';
        if (url) { console.log(`${tag} ✅ ${url}`); return url; }

        // 如果返回 image_id，查询真实 URL
        const imgId = data.upload_file?.image_id || data.image_id;
        if (imgId) {
          console.log(`${tag} image_id=${imgId}, 查询...`);
          try {
            const r2 = await fetch('https://api.zhihu.com/images/' + imgId, { credentials: 'include' });
            if (r2.ok) {
              const d2 = await r2.json();
              const u2 = d2.original_src || d2.src || d2.url || '';
              if (u2) { console.log(`${tag} ✅ ${u2}`); return u2; }
            }
          } catch (_) {}
        }
      } catch (e) { console.warn(`${tag} 异常:`, e); }
    }
    console.warn(`${tag} ❌ ${name} 全部失败`);
    return null;
  }

  /* ── 主流程 ── */
  const doc = new DOMParser().parseFromString(bodyHtml || '', 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  let success = 0, total = 0;

  for (let i = 0; i < imgs.length; i++) {
    const src = imgs[i].getAttribute('src') || '';
    if (!src.startsWith('data:image/')) continue;
    total++;
    try {
      const rawBlob = dataUrlToBlob(src);
      if (!rawBlob) { console.warn(`${tag} 图片${i} dataUrl转Blob失败`); continue; }

      const blob = await compressImage(rawBlob);
      const ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
      const cdnUrl = await uploadOne(blob, `img${i}.${ext}`);

      if (cdnUrl) {
        imgs[i].setAttribute('src', cdnUrl);
        success++;
      } else {
        // 上传失败 → 文字占位符（避免 data URL 让编辑器崩溃）
        const p = doc.createElement('p');
        p.textContent = `[${imgs[i].getAttribute('alt') || '图片'}]`;
        imgs[i].replaceWith(p);
      }
    } catch (e) {
      console.warn(`${tag} 图片${i} 处理异常:`, e);
      const p = doc.createElement('p');
      p.textContent = `[${imgs[i].getAttribute('alt') || '图片'}]`;
      imgs[i].replaceWith(p);
    }
  }

  console.log(`${tag} 完成: ${success}/${total} 张上传成功`);
  return doc.body.innerHTML || bodyHtml;
}

function fillXiaohongshu(title, bodyHtml) {
  const TITLE_SELS = [
    'input[placeholder*="标题"]',
    'input[placeholder*="填写标题"]',
    'textarea[placeholder*="标题"]',
    '[contenteditable="true"][data-placeholder*="标题"]',
    'input[type="text"]'
  ];
  const BODY_SELS = [
    '[contenteditable="true"]',
    'textarea[placeholder*="内容"]',
    'textarea[placeholder*="正文"]',
    '.ql-editor',
    '[role="textbox"]',
    'div[contenteditable]',
    'textarea'
  ];

  function find(sels) {
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function triggerInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let ok = false;
  const titleEl = find(TITLE_SELS);
  if (titleEl) {
    if (titleEl.contentEditable === 'true') {
      titleEl.innerHTML = title || '';
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(titleEl, title || '');
      else titleEl.value = title || '';
    }
    triggerInput(titleEl);
    ok = true;
  }

  const bodyEl = find(BODY_SELS);
  if (bodyEl) {
    if (bodyEl.contentEditable === 'true' || bodyEl.getAttribute('contenteditable') === 'true') {
      bodyEl.innerHTML = bodyHtml || '';
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(bodyEl, bodyEl.tagName === 'TEXTAREA' ? (new DOMParser().parseFromString(bodyHtml || '', 'text/html').body.textContent || '') : (bodyHtml || ''));
      else bodyEl.value = bodyHtml || '';
    }
    triggerInput(bodyEl);
    ok = true;
  }

  return { success: ok, error: ok ? '' : '未找到可填充的输入框' };
}

/**
 * 注入到腾讯云创作者平台写文章页面的填充函数
 */
function fillTencentCloud(title, bodyHtml) {
  const TITLE_SELS = [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[type="text"]',
    '[contenteditable="true"][data-placeholder*="标题"]'
  ];
  const BODY_SELS = [
    '.ProseMirror[contenteditable="true"]',
    '.ql-editor',
    '.public-DraftEditor-content [contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea[placeholder*="正文"]',
    'textarea[placeholder*="内容"]',
    'textarea'
  ];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function find(sels) {
    for (const sel of sels) {
      try {
        const list = Array.from(document.querySelectorAll(sel));
        const el = list.find((node) => isVisible(node));
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function triggerInput(el) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function htmlToText(html) {
    try {
      return new DOMParser().parseFromString(html || '', 'text/html').body.textContent || '';
    } catch (_) {
      return '';
    }
  }

  function normalizeHtml(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('script, style, iframe').forEach((el) => el.remove());
    doc.querySelectorAll('img').forEach((img) => {
      img.removeAttribute('width');
      img.removeAttribute('height');
      const style = (img.getAttribute('style') || '')
        .replace(/(^|;)\s*width\s*:[^;]*/gi, '')
        .replace(/(^|;)\s*height\s*:[^;]*/gi, '')
        .replace(/(^|;)\s*max-width\s*:[^;]*/gi, '')
        .trim();
      const baseStyle = 'max-width:100%;height:auto;display:block;margin:8px 0;';
      img.setAttribute('style', style ? `${style};${baseStyle}` : baseStyle);
    });
    return doc.body.innerHTML || '';
  }

  let ok = false;

  const titleEl = find(TITLE_SELS);
  if (titleEl) {
    if (titleEl.contentEditable === 'true' || titleEl.getAttribute('contenteditable') === 'true') {
      titleEl.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      sel.removeAllRanges();
      sel.addRange(range);
      try { document.execCommand('insertText', false, title || ''); } catch (_) { titleEl.textContent = title || ''; }
    } else {
      setNativeValue(titleEl, title || '');
    }
    triggerInput(titleEl);
    ok = true;
  }

  const bodyEl = find(BODY_SELS);
  if (bodyEl) {
    const cleanedHtml = normalizeHtml(bodyHtml || '');
    if (bodyEl.contentEditable === 'true' || bodyEl.getAttribute('contenteditable') === 'true') {
      bodyEl.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(bodyEl);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand('insertHTML', false, cleanedHtml);
      } catch (_) {
        bodyEl.innerHTML = cleanedHtml;
      }
      triggerInput(bodyEl);
    } else {
      setNativeValue(bodyEl, htmlToText(cleanedHtml));
      triggerInput(bodyEl);
    }
    ok = true;
  }

  return { success: ok, error: ok ? '' : '未找到可填充的输入框' };
}

/**
 * 注入到知乎写文章页面的填充函数（async，先压缩图片再填充）
 */
function fillZhihu(title, bodyHtml) {
  const TITLE_SELS = [
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
    '[contenteditable="true"][data-placeholder*="标题"]',
    '.WriteIndex-titleInput textarea',
    '.WriteIndex-titleInput input',
    'h1[contenteditable="true"]'
  ];
  const BODY_SELS = [
    '.ProseMirror[contenteditable="true"]',
    '[data-contents="true"] [contenteditable="true"]',
    '.public-DraftEditor-content [contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '.ql-editor',
    'textarea'
  ];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function find(sels) {
    for (const sel of sels) {
      try {
        const list = Array.from(document.querySelectorAll(sel));
        const el = list.find((node) => isVisible(node));
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function findBodyExcept(sels, excludedEl) {
    for (const sel of sels) {
      try {
        const list = Array.from(document.querySelectorAll(sel));
        const el = list.find((node) => isVisible(node) && node !== excludedEl);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function triggerInput(el) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function htmlToText(html) {
    try {
      return new DOMParser().parseFromString(html || '', 'text/html').body.textContent || '';
    } catch (_) {
      return '';
    }
  }

  /* 基础清洗：移除危险标签 + 剥离残留的 data:image URL（安全网） */
  function normalizeForZhihu(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('script, style, iframe').forEach((el) => el.remove());
    // 安全网：如果仍有 data:image URL 残留（上传失败时），替换为文字占位符
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:image/')) {
        const alt = img.getAttribute('alt') || '图片';
        const p = doc.createElement('p');
        p.textContent = '[' + alt + ']';
        img.replaceWith(p);
      }
    });
    return doc.body.innerHTML || '';
  }

  /* 去掉 data-URL 图片（回退用，避免超大 HTML 导致编辑器截断） */
  function stripDataImages(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:')) {
        const alt = img.getAttribute('alt') || '图片';
        const p = doc.createElement('p');
        p.textContent = `[${alt}]`;
        img.replaceWith(p);
      }
    });
    return doc.body.innerHTML || '';
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  /* ── 把 data-URL 转成 Blob/File ── */
  function dataUrlToFile(dataUrl, idx) {
    try {
      const arr = dataUrl.split(',');
      const mimeMatch = arr[0].match(/:(.*?);/);
      if (!mimeMatch) return null;
      const mime = mimeMatch[1];
      const bstr = atob(arr[1]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      const ext = mime.split('/')[1] || 'png';
      return new File([u8], `image${idx}.${ext}`, { type: mime });
    } catch (_) {
      return null;
    }
  }

  /* ── 方式 A: 模拟粘贴事件（纯文本/HTML，不含图片文件） ── */
  function simulatePaste(el, html, plainText) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand('delete', false); } catch (_) {}
    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html || '');
      dt.setData('text/plain', plainText || '');
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(pasteEvt);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ── 方式 B: execCommand('insertHTML') ── */
  function fillByExecCommand(el, html) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      return document.execCommand('insertHTML', false, html || '');
    } catch (_) {
      return false;
    }
  }

  /* ── 方式 C: 直接构造 DOM 节点追加 ── */
  function fillByDomBuild(el, html) {
    el.innerHTML = '';
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const nodes = Array.from(doc.body.childNodes);
    if (nodes.length === 0) {
      (html || '').split(/\n/).forEach((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        el.appendChild(p);
      });
    } else {
      nodes.forEach((node) => el.appendChild(document.importNode(node, true)));
    }
    triggerInput(el);
  }

  /* ── 方式 D: 纯文本按段落构建 DOM ── */
  function fillPlainTextByDom(el, text) {
    el.innerHTML = '';
    (text || '').split(/\n/).forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      el.appendChild(p);
    });
    triggerInput(el);
  }

  function getInsertedLen(el) {
    return (el.innerText || el.textContent || '').length;
  }

  /* ── 统一填充入口：四种策略依次尝试 ── */
  function fillEditable(el, html, plainText, targetTextLen) {
    const threshold = Math.max(Math.floor(targetTextLen * 0.6), 20);
    simulatePaste(el, html, plainText);
    if (getInsertedLen(el) >= threshold) return;
    fillByExecCommand(el, html);
    if (getInsertedLen(el) >= threshold) { triggerInput(el); return; }
    fillByDomBuild(el, html);
    if (getInsertedLen(el) >= threshold) return;
    fillPlainTextByDom(el, plainText);
  }


  let ok = false;
  const titleEl = find(TITLE_SELS);
  if (titleEl) {
    if (titleEl.contentEditable === 'true') {
      titleEl.focus();
      const s = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(titleEl);
      s.removeAllRanges();
      s.addRange(r);
      try { document.execCommand('insertText', false, title || ''); } catch (_) { titleEl.textContent = title || ''; }
      triggerInput(titleEl);
    } else {
      setNativeValue(titleEl, title || '');
      triggerInput(titleEl);
    }
    ok = true;
  }

  const bodyEl = findBodyExcept(BODY_SELS, titleEl);
  if (bodyEl) {
    // 图片已在 background 中上传替换为 CDN URL，这里直接清洗并填充
    const cleanedHtml = normalizeForZhihu(bodyHtml || '');
    const plainText = htmlToText(cleanedHtml);
    const targetTextLen = plainText.length;

    if (bodyEl.contentEditable === 'true' || bodyEl.getAttribute('contenteditable') === 'true') {
      fillEditable(bodyEl, cleanedHtml, plainText, targetTextLen);

      // 如果文字被截断，回退纯文本
      const afterLen = getInsertedLen(bodyEl);
      if (targetTextLen > 0 && afterLen < Math.floor(targetTextLen * 0.5)) {
        const noImgHtml = stripDataImages(cleanedHtml);
        const noImgPlain = htmlToText(noImgHtml);
        fillEditable(bodyEl, noImgHtml, noImgPlain, noImgPlain.length);
      }
    } else {
      setNativeValue(bodyEl, plainText);
      triggerInput(bodyEl);
    }
    ok = true;
  }

  return { success: ok, error: ok ? '' : '未找到可填充的输入框' };
}

function escapeHtmlForFill(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PLATFORM_FILL_FUNCS = {
  xiaohongshu: fillXiaohongshu,
  zhihu: fillZhihu,
  tencentcloud: fillTencentCloud
};

/* 安全网：剥离 HTML 中所有 data:image URL，防止编辑器崩溃 */
function stripDataImagesFromHtml(html) {
  try {
    // 使用 service worker 的简单正则替换（service worker 没有 DOMParser）
    return (html || '').replace(/<img\b[^>]*\bsrc\s*=\s*["']data:image\/[^"']*["'][^>]*\/?>/gi, (match) => {
      const altM = match.match(/\balt\s*=\s*["']([^"']*)["']/i);
      return '<p>[' + (altM ? altM[1] : '图片') + ']</p>';
    });
  } catch (_) { return html; }
}

async function handleSync(msg, sendResponse) {
  const { title, bodyHtml, coverUrl, platforms } = msg;
  if (!platforms || platforms.length === 0) {
    sendResponse({ type: 'SYNC_RESULT', success: false, error: '请至少选择一个平台' });
    return;
  }

  const results = {};

  for (const platform of platforms) {
    const url = PLATFORM_URLS[platform];
    const fillFunc = PLATFORM_FILL_FUNCS[platform];
    if (!url || !fillFunc) {
      results[platform] = { success: false, error: '未知平台' };
      continue;
    }

    try {
      const tab = await new Promise((resolve) => {
        chrome.tabs.create({ url, active: true }, resolve);
      });

      await waitForTabComplete(tab.id);
      await sleep(3000); // 等 SPA 渲染

      // 知乎平台：在 ISOLATED world 内容脚本中上传图片
      // 内容脚本的同源 fetch 自动使用页面的 Origin 和 Cookie（非扩展的）
      let platformBodyHtml = bodyHtml;
      if (platform === 'zhihu') {
        try {
          const uploadResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: zhihuUploadImages,
            args: [bodyHtml],
            // 不指定 world → 默认 ISOLATED world，async 正常工作
          });
          if (uploadResults?.[0]?.result) {
            platformBodyHtml = uploadResults[0].result;
            console.log('[ContentShare] 知乎图片上传脚本执行完成');
          } else {
            console.warn('[ContentShare] 上传脚本返回空结果，剥离data图片');
            platformBodyHtml = stripDataImagesFromHtml(bodyHtml);
          }
        } catch (e) {
          console.warn('[ContentShare] 上传脚本执行失败，剥离data图片:', e);
          platformBodyHtml = stripDataImagesFromHtml(bodyHtml);
        }
      }

      const execResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillFunc,
        args: [title, platformBodyHtml]
      });

      if (execResults && execResults[0] && execResults[0].result) {
        results[platform] = execResults[0].result;
      } else {
        results[platform] = { success: false, error: '填充脚本未返回结果' };
      }
    } catch (e) {
      results[platform] = { success: false, error: e?.message || '打开页面失败' };
    }
  }

  const hasFail = Object.values(results).some((r) => !r.success);
  if (hasFail) {
    try {
      chrome.notifications.create({
        type: 'basic',
        title: '内容分发',
        message: '部分平台自动填充可能未成功，请检查页面或手动粘贴。'
      });
    } catch (_) {}
  }

  sendResponse({ type: 'SYNC_RESULT', success: true, results });
}
