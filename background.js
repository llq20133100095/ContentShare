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
  if (message.type === 'ZHIHU_PARSE_MEDIA') {
    handleZhihuParseMedia(message.url, sendResponse);
    return true;
  }
});

// ─── 工具函数 ────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 知乎媒体下载：解析与提取 ───────────────────────────────

const ZHIHU_API_HEADERS = {
  'accept': 'application/json',
  'x-api-version': '3.0.91',
  'x-app-version': '8.0.0',
  'x-app-za': 'OS=iOS&Release=17.0&Model=iPhone15,2&VersionName=8.0.0',
  'x-app-build': 'release'
};

function parseZhihuUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let m = raw.match(/zhihu\.com\/question\/(\d+)\/answer\/(\d+)/i);
  if (m) return { type: 'answer', questionId: m[1], answerId: m[2] };

  m = raw.match(/zhihu\.com\/p\/(\d+)/i);
  if (m) return { type: 'article', articleId: m[1] };

  m = raw.match(/zhihu\.com\/question\/(\d+)/i);
  if (m) return { type: 'question', questionId: m[1] };

  return null;
}

async function fetchJson(url, headers = {}) {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'omit'
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

function pickFirstContent(candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

async function fetchZhihuContent(parsed) {
  if (!parsed) return '';
  if (parsed.type === 'answer') {
    const apiV3 = `https://api.zhihu.com/answers/${parsed.answerId}?include=content%2Cexcerpt%2Cvoteup_count`;
    const apiV4 = `https://www.zhihu.com/api/v4/answers/${parsed.answerId}?include=content`;
    const d1 = await fetchJson(apiV3, ZHIHU_API_HEADERS);
    const d2 = d1?.content ? null : await fetchJson(apiV4, {});
    return pickFirstContent([d1?.content, d2?.content]);
  }
  if (parsed.type === 'article') {
    const apiV3 = `https://api.zhihu.com/articles/${parsed.articleId}?include=content`;
    const apiV4 = `https://www.zhihu.com/api/v4/articles/${parsed.articleId}?include=content`;
    const d1 = await fetchJson(apiV3, ZHIHU_API_HEADERS);
    const d2 = d1?.content ? null : await fetchJson(apiV4, {});
    return pickFirstContent([d1?.content, d2?.content]);
  }
  if (parsed.type === 'question') {
    const apiV3 = `https://api.zhihu.com/questions/${parsed.questionId}/answers?include=content%2Cexcerpt%2Cvoteup_count&limit=1&offset=0`;
    const apiV4 = `https://www.zhihu.com/api/v4/questions/${parsed.questionId}/answers?include=content&limit=1&offset=0`;
    const d1 = await fetchJson(apiV3, ZHIHU_API_HEADERS);
    const first1 = Array.isArray(d1?.data) ? d1.data[0] : null;
    const d2 = first1?.content ? null : await fetchJson(apiV4, {});
    const first2 = Array.isArray(d2?.data) ? d2.data[0] : null;
    return pickFirstContent([first1?.content, first2?.content]);
  }
  return '';
}

function extractAttrFromTag(tag, attrName) {
  const name = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(tag || '').match(re);
  if (!m) return '';
  return m[2] || m[3] || m[4] || '';
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u || u.startsWith('data:')) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  return u;
}

function buildNoWatermarkUrl(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  return `https://pic1.zhimg.com/${t}_r.jpg`;
}

function stripSourceParam(url) {
  return String(url || '').replace(/\?source=[^&]*$/i, '');
}

function extractImageUrlsFromHtml(htmlContent) {
  const html = String(htmlContent || '');
  const seen = new Set();
  const images = [];
  const tokenSeen = new Set();

  const add = (url, thumb, width, height) => {
    const clean = normalizeUrl(url);
    if (!clean || !/zhimg\.com/i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    images.push({
      url: clean,
      thumbnail: normalizeUrl(thumb) || clean,
      width: Number(width || 0) || 0,
      height: Number(height || 0) || 0
    });
  };

  const addToken = (token) => {
    const t = String(token || '').trim();
    if (!t || tokenSeen.has(t)) return;
    tokenSeen.add(t);
    add(buildNoWatermarkUrl(t), '', 0, 0);
  };

  // 1) 常规 img 标签提取
  const imgTagRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[0];
    const token = extractAttrFromTag(tag, 'data-original-token');
    addToken(token);
    const nowm = token ? buildNoWatermarkUrl(token) : '';
    const original = extractAttrFromTag(tag, 'data-original')
      || extractAttrFromTag(tag, 'data-actualsrc')
      || extractAttrFromTag(tag, 'src');
    const fallback = stripSourceParam(normalizeUrl(original));
    const best = nowm || fallback;
    const thumb = extractAttrFromTag(tag, 'src') || original;
    add(best, thumb, extractAttrFromTag(tag, 'data-rawwidth'), extractAttrFromTag(tag, 'data-rawheight'));
  }

  // 2) figure/div 等非 img 标签上的 token（知乎新版常见）
  const tokenRe = /data-original-token\s*=\s*["']([^"']+)["']/gi;
  while ((m = tokenRe.exec(html)) !== null) {
    addToken(m[1]);
  }

  // 3) 非 img 标签上的原图地址属性
  const dataOrigRe = /\b(?:data-original|data-actualsrc)\s*=\s*["']([^"']+)["']/gi;
  while ((m = dataOrigRe.exec(html)) !== null) {
    add(stripSourceParam(normalizeUrl(m[1])), '', 0, 0);
  }

  // 4) 全文 zhimg 直链兜底（包含 noscript/json 片段）
  const zhimgUrlRe = /https?:\/\/[^"'<>\s]*zhimg\.com\/[^"'<>\s]+/gi;
  while ((m = zhimgUrlRe.exec(html)) !== null) {
    add(stripSourceParam(normalizeUrl(m[0])), '', 0, 0);
  }

  return images;
}

function extractVideoIdsFromHtml(htmlContent) {
  const html = String(htmlContent || '');
  const ids = [];
  const seen = new Set();

  const videoBoxRe = /<a\b[^>]*class=["'][^"']*video-box[^"']*["'][^>]*>/gi;
  let m;
  while ((m = videoBoxRe.exec(html)) !== null) {
    const tag = m[0];
    let vid = extractAttrFromTag(tag, 'data-lens-id');
    if (!vid) {
      const href = extractAttrFromTag(tag, 'href');
      const hm = String(href || '').match(/video\/(\d+)/i);
      if (hm) vid = hm[1];
    }
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      ids.push({
        id: vid,
        poster: normalizeUrl(extractAttrFromTag(tag, 'data-poster')) || ''
      });
    }
  }

  const fallbackRe = /zhihu\.com\/video\/(\d+)/gi;
  while ((m = fallbackRe.exec(html)) !== null) {
    const vid = m[1];
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      ids.push({ id: vid, poster: '' });
    }
  }

  return ids;
}

function formatSize(sizeBytes) {
  const n = Number(sizeBytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function fetchVideoDetail(videoId, poster = '') {
  try {
    const apiUrl = `https://lens.zhihu.com/api/v4/videos/${videoId}`;
    const data = await fetchJson(apiUrl, {});
    const playlist = data?.playlist || {};
    const priority = ['HD', 'SD', 'LD'];
    for (const quality of priority) {
      const item = playlist[quality];
      if (item?.play_url) {
        return {
          id: String(videoId),
          poster,
          play_url: item.play_url,
          quality,
          width: Number(item.width || 0) || 0,
          height: Number(item.height || 0) || 0,
          size: Number(item.size || 0) || 0,
          size_str: formatSize(item.size || 0)
        };
      }
    }
    const keys = Object.keys(playlist);
    for (const k of keys) {
      const item = playlist[k];
      if (item?.play_url) {
        return {
          id: String(videoId),
          poster,
          play_url: item.play_url,
          quality: k,
          width: Number(item.width || 0) || 0,
          height: Number(item.height || 0) || 0,
          size: Number(item.size || 0) || 0,
          size_str: formatSize(item.size || 0)
        };
      }
    }
  } catch (_) {}
  return null;
}

function mergeImageLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    const arr = Array.isArray(list) ? list : [];
    for (const item of arr) {
      const url = normalizeUrl(item?.url || '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        thumbnail: normalizeUrl(item?.thumbnail || '') || url,
        width: Number(item?.width || 0) || 0,
        height: Number(item?.height || 0) || 0
      });
    }
  }
  return out;
}

function mergeVideoRefLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    const arr = Array.isArray(list) ? list : [];
    for (const item of arr) {
      const id = String(item?.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        poster: normalizeUrl(item?.poster || '')
      });
    }
  }
  return out;
}

/**
 * 在知乎页面中以同源身份调用 API，拿到完整未截断的 content HTML，
 * 再提取图片和视频。参考 zhihu_download 项目思路。
 */
async function extractMediaViaPageApi(parsedUrl, pageUrl) {
  let tabId = null;
  try {
    // 打开知乎页面（后台标签），获得同源上下文
    const tab = await new Promise((resolve) => {
      chrome.tabs.create({ url: pageUrl, active: false }, resolve);
    });
    tabId = tab?.id || null;
    if (!tabId) return { images: [], videoRefs: [] };

    await waitForTabComplete(tabId, 25000);
    await sleep(2000);

    const exec = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (parsedInfo) => {
        // ─── 工具函数（完全自包含，不能引用外部变量） ───
        const norm = (u) => {
          let s = String(u || '').trim();
          if (!s || s.startsWith('data:')) return '';
          if (s.startsWith('//')) s = 'https:' + s;
          return s;
        };
        const stripSource = (u) => String(u || '').replace(/\?source=[^&]*$/i, '');
        const buildNowm = (token) => {
          const t = String(token || '').trim();
          return t ? `https://pic1.zhimg.com/${t}_r.jpg` : '';
        };

        // ─── 1) 同源 API 调用：拿完整 content HTML ───
        let apiContent = '';
        try {
          let apiPath = '';
          if (parsedInfo.type === 'answer') {
            apiPath = '/api/v4/answers/' + parsedInfo.answerId + '?include=content';
          } else if (parsedInfo.type === 'article') {
            apiPath = '/api/v4/articles/' + parsedInfo.articleId + '?include=content';
          } else if (parsedInfo.type === 'question') {
            apiPath = '/api/v4/questions/' + parsedInfo.questionId + '/answers?include=content&limit=5&offset=0';
          }
          if (apiPath) {
            const resp = await fetch(apiPath, { credentials: 'include' });
            if (resp.ok) {
              const data = await resp.json();
              if (parsedInfo.type === 'question') {
                const items = Array.isArray(data?.data) ? data.data : [];
                apiContent = items.map(i => i.content || '').join('\n');
              } else {
                apiContent = data?.content || '';
              }
            }
          }
        } catch (_) {}

        // ─── 2) 从 API content HTML 提取图片与视频（严格对齐 zhihu_download） ───
        // 只从 <figure> 和 <noscript> 中的 <img> 提取，不做全文扫描
        const images = [];
        const seenImg = new Set();
        const addImg = (url, thumb, w, h) => {
          const clean = norm(url);
          if (!clean || !/zhimg\.com/i.test(clean) || seenImg.has(clean)) return;
          seenImg.add(clean);
          images.push({
            url: clean,
            thumbnail: norm(thumb) || clean,
            width: Number(w || 0) || 0,
            height: Number(h || 0) || 0
          });
        };

        const videoRefs = [];
        const seenVideo = new Set();
        const addVid = (id, poster) => {
          const vid = String(id || '').trim();
          if (!vid || seenVideo.has(vid)) return;
          seenVideo.add(vid);
          videoRefs.push({ id: vid, poster: norm(poster) });
        };

        if (apiContent) {
          const doc = new DOMParser().parseFromString(apiContent, 'text/html');

          // figure > img （文章正文图片的标准结构）
          for (const figure of Array.from(doc.querySelectorAll('figure'))) {
            for (const img of Array.from(figure.querySelectorAll('img'))) {
              const token = img.getAttribute('data-original-token') || '';
              const nowm = buildNowm(token);
              const orig = img.getAttribute('data-original')
                || img.getAttribute('data-actualsrc')
                || img.getAttribute('src') || '';
              const fallback = stripSource(norm(orig));
              const best = nowm || fallback;
              let thumb = img.getAttribute('src') || orig;
              if (thumb && thumb.startsWith('data:')) thumb = orig;
              addImg(best, thumb,
                img.getAttribute('data-rawwidth'),
                img.getAttribute('data-rawheight'));
            }
          }

          // noscript > img （部分回答的备用结构）
          for (const ns of Array.from(doc.querySelectorAll('noscript'))) {
            const inner = new DOMParser().parseFromString(ns.textContent || '', 'text/html');
            for (const img of Array.from(inner.querySelectorAll('img'))) {
              const token = img.getAttribute('data-original-token') || '';
              const nowm = buildNowm(token);
              const orig = img.getAttribute('data-original')
                || img.getAttribute('src') || '';
              const fallback = stripSource(norm(orig));
              addImg(nowm || fallback, '',
                img.getAttribute('data-rawwidth'),
                img.getAttribute('data-rawheight'));
            }
          }

          // 视频：a.video-box + 正则兜底
          for (const a of Array.from(doc.querySelectorAll('a.video-box'))) {
            let vid = a.getAttribute('data-lens-id') || '';
            if (!vid) {
              const href = a.getAttribute('href') || '';
              const hm = href.match(/video\/(\d+)/i);
              if (hm) vid = hm[1];
            }
            addVid(vid, a.getAttribute('data-poster') || '');
          }
          let m;
          const videoUrlRe = /zhihu\.com\/video\/(\d+)/gi;
          while ((m = videoUrlRe.exec(apiContent)) !== null) addVid(m[1], '');
        }

        // ─── 3) 提取正文纯文本 ───
        let textContent = '';
        if (apiContent) {
          const textDoc = new DOMParser().parseFromString(apiContent, 'text/html');
          // 移除 figure/noscript 等纯媒体标签，只留文本
          textDoc.querySelectorAll('figure, noscript, script, style').forEach(el => el.remove());
          textContent = (textDoc.body?.textContent || '').replace(/\s+/g, ' ').trim();
        }

        return { images, videoRefs, textContent };
      },
      args: [parsedUrl]
    });

    const result = exec?.[0]?.result || { images: [], videoRefs: [], textContent: '' };
    return {
      images: Array.isArray(result.images) ? result.images : [],
      videoRefs: Array.isArray(result.videoRefs) ? result.videoRefs : [],
      textContent: typeof result.textContent === 'string' ? result.textContent : ''
    };
  } catch (_) {
    return { images: [], videoRefs: [], textContent: '' };
  } finally {
    if (tabId) {
      try { await new Promise((resolve) => chrome.tabs.remove(tabId, resolve)); } catch (_) {}
    }
  }
}

async function handleZhihuParseMedia(url, sendResponse) {
  try {
    const parsed = parseZhihuUrl(url);
    if (!parsed) {
      sendResponse({ type: 'ZHIHU_PARSE_RESULT', success: false, error: '无法识别的知乎链接，请输入回答、问题或文章链接' });
      return;
    }

    // 核心策略：在知乎页面中以同源身份调用 API（带 cookies），
    // 同时从渲染 DOM 提取，两路合并确保不漏图。
    const pageResult = await extractMediaViaPageApi(parsed, String(url || ''));
    let images = pageResult.images;
    let videoRefs = pageResult.videoRefs;
    let textContent = pageResult.textContent || '';

    // 如果页面通道失败（被拦截/超时），降级用 service worker 直接调 API
    if (images.length === 0) {
      const content = await fetchZhihuContent(parsed);
      if (content) {
        images = extractImageUrlsFromHtml(content);
        videoRefs = extractVideoIdsFromHtml(content);
      }
    }

    const videos = [];
    for (const ref of mergeVideoRefLists(videoRefs)) {
      const detail = await fetchVideoDetail(ref.id, ref.poster);
      if (detail) videos.push(detail);
    }

    if (images.length === 0 && videos.length === 0 && !textContent) {
      sendResponse({ type: 'ZHIHU_PARSE_RESULT', success: false, error: '该页面未找到图片、视频或文本内容' });
      return;
    }

    sendResponse({
      type: 'ZHIHU_PARSE_RESULT',
      success: true,
      data: {
        images,
        videos,
        textContent
      }
    });
  } catch (err) {
    sendResponse({
      type: 'ZHIHU_PARSE_RESULT',
      success: false,
      error: err?.message || '解析失败'
    });
  }
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
async function fillTencentCloud(title, bodyHtml) {
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

  function collectInlineDataImages(html) {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      const list = [];
      const seed = Date.now().toString(36);
      doc.querySelectorAll('img').forEach((img, idx) => {
        const src = img.getAttribute('src') || '';
        if (/^data:image\//i.test(src)) {
          const altText = (img.getAttribute('alt') || '').trim() || `图片${idx + 1}`;
          const token = `cs-inline-${seed}-${idx + 1}`;
          const markerText = `[[CS_IMG_${seed}_${idx + 1}]]`;
          list.push({
            index: idx + 1,
            src,
            alt: altText,
            token,
            markerText
          });
          const marker = doc.createElement('p');
          marker.setAttribute('data-cs-inline-token', token);
          marker.textContent = markerText;
          marker.style.color = '#6b7280';
          img.replaceWith(marker);
        }
      });
      return {
        htmlWithoutInlineImages: doc.body.innerHTML || html || '',
        inlineImages: list
      };
    } catch (_) {
      return { htmlWithoutInlineImages: html || '', inlineImages: [] };
    }
  }

  function findMarker(bodyEl, token, markerText) {
    if (!bodyEl) return null;
    try {
      if (token) {
        const escaped = token.replace(/"/g, '\\"');
        const byAttr = bodyEl.querySelector(`[data-cs-inline-token="${escaped}"]`);
        if (byAttr) return byAttr;
      }
    } catch (_) {}
    if (!markerText) return null;
    const nodes = Array.from(bodyEl.querySelectorAll('p,div,span,li'));
    const target = String(markerText || '').trim();
    return nodes.find((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || !target) return false;
      return txt === target || txt.includes(target);
    }) || null;
  }

  function updateMarkerText(bodyEl, token, markerText, text) {
    const marker = findMarker(bodyEl, token, markerText);
    if (!marker) return;
    marker.textContent = text;
  }

  function removeMarker(bodyEl, token, markerText) {
    const marker = findMarker(bodyEl, token, markerText);
    if (!marker) return;
    marker.remove();
  }

  function cleanupIfEmpty(node) {
    if (!node || !node.parentNode) return;
    const txt = (node.textContent || '').trim();
    const hasImg = node.querySelector && node.querySelector('img');
    if (!txt && !hasImg) {
      node.remove();
    }
  }

  function moveLatestInsertedImageToMarker(bodyEl, token, markerText, imgCountBefore) {
    if (!bodyEl) return false;
    const marker = findMarker(bodyEl, token, markerText);
    if (!marker) return false;
    const imgs = Array.from(bodyEl.querySelectorAll('img'));
    if (imgs.length <= imgCountBefore) return false;

    // 优先选择“新增区间”中的最后一张，通常是刚上传的图片。
    const candidate = imgs[imgs.length - 1];
    if (!candidate) return false;
    if (candidate === marker || marker.contains(candidate)) return false;

    const oldParent = candidate.parentElement;
    marker.replaceWith(candidate);
    cleanupIfEmpty(oldParent);
    return true;
  }

  async function waitForImageCountIncrease(bodyEl, beforeCount, timeoutMs = 9000) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const now = bodyEl.querySelectorAll('img').length;
      if (now > beforeCount) return now;
      await wait(450);
    }
    return bodyEl.querySelectorAll('img').length;
  }

  function stripAllMarkerTokens(bodyEl) {
    if (!bodyEl) return;
    try {
      const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
      const toClean = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!n || !n.nodeValue) continue;
        if (/\[\[CS_IMG_[^\]]+\]\]/.test(n.nodeValue)) toClean.push(n);
      }
      toClean.forEach((n) => {
        n.nodeValue = n.nodeValue.replace(/\[\[CS_IMG_[^\]]+\]\]/g, '').replace(/\s{2,}/g, ' ').trim();
      });

      Array.from(bodyEl.querySelectorAll('p,div,span,li')).forEach((el) => {
        const txt = (el.textContent || '').trim();
        const hasImg = !!el.querySelector('img');
        if (!txt && !hasImg) el.remove();
      });
      triggerInput(bodyEl);
    } catch (_) {}
  }

  function placeCaretAtMarker(bodyEl, token, markerText) {
    const marker = findMarker(bodyEl, token, markerText);
    if (!bodyEl || !marker) return false;
    try {
      bodyEl.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStartBefore(marker);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function dataUrlToSupportedFile(dataUrl, idx, alt) {
    try {
      const arr = String(dataUrl || '').split(',');
      const mimeMatch = arr[0]?.match(/:(.*?);/);
      if (!mimeMatch || !arr[1]) return null;
      const mime = mimeMatch[1];
      const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const bstr = atob(arr[1]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      const safeBase = `${String(alt || 'image').replace(/[^\w\u4e00-\u9fa5-]/g, '_') || 'image'}_${idx}`;
      const rawFile = new File([u8], `${safeBase}.${ext}`, { type: mime });
      const normalizedMime = String(mime).toLowerCase();
      const supported = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif']);
      if (supported.has(normalizedMime)) return rawFile;

      // 腾讯云不支持 webp 等格式，统一转 jpeg 再上传。
      const jpegFile = await convertFileToJpeg(rawFile, safeBase);
      return jpegFile || rawFile;
    } catch (_) {
      return null;
    }
  }

  async function convertFileToJpeg(file, baseName) {
    try {
      const objectUrl = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = objectUrl;
      });
      URL.revokeObjectURL(objectUrl);

      const w = Math.max(1, img.naturalWidth || img.width || 1);
      const h = Math.max(1, img.naturalHeight || img.height || 1);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) return null;
      return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
    } catch (_) {
      return null;
    }
  }

  async function tryPasteSingleImage(bodyEl, file, token, markerText) {
    if (!bodyEl || !file) return false;
    placeCaretAtMarker(bodyEl, token, markerText);
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      bodyEl.dispatchEvent(evt);
      return true;
    } catch (_) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        const evt = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        });
        bodyEl.dispatchEvent(evt);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function tryUploadSingleImageByFileInput(file) {
    if (!file) return false;
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (fileInputs.length === 0) return false;

    // 优先命中声明图片上传能力的 input。
    const target = fileInputs.find((el) => {
      const accept = (el.getAttribute('accept') || '').toLowerCase();
      return accept.includes('image');
    }) || fileInputs[0];

    if (!target) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      target.files = dt.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function uploadInlineImagesAtMarkers(bodyEl, inlineImages) {
    if (!bodyEl || !inlineImages || inlineImages.length === 0) return { attempted: 0, success: 0 };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let success = 0;

    for (let i = 0; i < inlineImages.length; i++) {
      const item = inlineImages[i];
      const alt = (item.alt || `图片${i + 1}`).trim() || `图片${i + 1}`;
      const file = await dataUrlToSupportedFile(item.src, i + 1, alt);
      if (!file) {
        updateMarkerText(bodyEl, item.token, item.markerText, `[${alt} 上传失败，请手动上传]`);
        continue;
      }

      const imgCountBefore = bodyEl.querySelectorAll('img').length;
      let sent = false;

      // 优先通过粘贴/拖拽在当前位置触发上传，保证图文对应。
      sent = await tryPasteSingleImage(bodyEl, file, item.token, item.markerText);
      if (!sent) {
        placeCaretAtMarker(bodyEl, item.token, item.markerText);
        sent = await tryUploadSingleImageByFileInput(file);
      }
      if (!sent) {
        updateMarkerText(bodyEl, item.token, item.markerText, `[${alt} 上传失败，请手动上传]`);
        continue;
      }

      const imgCountAfter = await waitForImageCountIncrease(bodyEl, imgCountBefore, 9000);
      if (imgCountAfter > imgCountBefore) {
        const moved = moveLatestInsertedImageToMarker(bodyEl, item.token, item.markerText, imgCountBefore);
        if (!moved) removeMarker(bodyEl, item.token, item.markerText);
        success++;
      } else {
        updateMarkerText(bodyEl, item.token, item.markerText, `[${alt} 上传失败，请手动上传]`);
      }
      triggerInput(bodyEl);
    }
    return { attempted: inlineImages.length, success };
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

  const bodyEl = findBodyExcept(BODY_SELS, titleEl);
  if (bodyEl) {
    const cleanedHtml = normalizeHtml(bodyHtml || '');
    const inlineInfo = collectInlineDataImages(cleanedHtml);
    if (bodyEl.contentEditable === 'true' || bodyEl.getAttribute('contenteditable') === 'true') {
      bodyEl.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(bodyEl);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand('insertHTML', false, inlineInfo.htmlWithoutInlineImages);
      } catch (_) {
        bodyEl.innerHTML = inlineInfo.htmlWithoutInlineImages;
      }
      // 部分编辑器会忽略 insertHTML；检测失败后强制回退 innerHTML。
      const expectedLen = htmlToText(inlineInfo.htmlWithoutInlineImages).trim().length;
      const actualLen = (bodyEl.innerText || bodyEl.textContent || '').trim().length;
      if (expectedLen > 0 && actualLen < Math.floor(expectedLen * 0.5)) {
        bodyEl.innerHTML = inlineInfo.htmlWithoutInlineImages;
      }
      triggerInput(bodyEl);

      // 尝试把 data:image 内嵌图作为文件粘贴到腾讯云编辑器，触发平台上传。
      if (inlineInfo.inlineImages.length > 0) {
        await uploadInlineImagesAtMarkers(bodyEl, inlineInfo.inlineImages);
      }
      // 最终兜底：清理可能残留的锚点文本 [[CS_IMG_xxx]]。
      stripAllMarkerTokens(bodyEl);
    } else {
      setNativeValue(bodyEl, htmlToText(inlineInfo.htmlWithoutInlineImages));
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

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeTencentImageUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = decodeHtmlEntities(u).replace(/^['"]|['"]$/g, '');
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  return u;
}

function extractAttrFromTag(tag, attrName) {
  const attr = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reg = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(tag || '').match(reg);
  if (!m) return '';
  return m[2] || m[3] || m[4] || '';
}

function preprocessTencentCloudBodyHtml(bodyHtml) {
  const srcList = [];
  let converted = 0;
  let dataImageCount = 0;
  const html = String(bodyHtml || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = normalizeTencentImageUrl(extractAttrFromTag(tag, 'src'));
    const altRaw = decodeHtmlEntities(extractAttrFromTag(tag, 'alt'));
    const alt = altRaw.trim() || '图片';

    if (!src) {
      converted++;
      return `<p>[${escapeHtmlForFill(alt)}：未提取到可用链接，请手动上传]</p>`;
    }
    if (/^https?:\/\//i.test(src)) {
      converted++;
      srcList.push(src);
      const safeUrl = escapeHtmlForFill(src);
      return `<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">图片链接：${safeUrl}</a></p>`;
    }
    if (/^data:image\//i.test(src)) {
      converted++;
      dataImageCount++;
      // 保留 data:image，后续在腾讯云页面中尝试模拟粘贴触发上传。
      return `<img src="${escapeHtmlForFill(src)}" alt="${escapeHtmlForFill(alt)}" />`;
    }
    converted++;
    return `<p>[${escapeHtmlForFill(alt)}：图片地址不可用，请手动上传]</p>`;
  });

  return { html, converted, dataImageCount, linkCount: srcList.length };
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
      if (platform === 'tencentcloud') {
        const processed = preprocessTencentCloudBodyHtml(bodyHtml || '');
        platformBodyHtml = processed.html;
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
