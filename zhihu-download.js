'use strict';

const urlInputEl = document.getElementById('zhihu-url');
const btnParseEl = document.getElementById('btn-parse');
const btnOpenMainEl = document.getElementById('btn-open-main');
const btnDownloadAllEl = document.getElementById('btn-download-all');
const statusEl = document.getElementById('status');
const resultWrapEl = document.getElementById('result-wrap');
const imageCountEl = document.getElementById('image-count');
const videoCountEl = document.getElementById('video-count');
const imageGridEl = document.getElementById('image-grid');
const videoGridEl = document.getElementById('video-grid');
const textSectionEl = document.getElementById('text-section');
const textContentEl = document.getElementById('text-content');
const btnCopyTextEl = document.getElementById('btn-copy-text');

let currentImages = [];
let currentVideos = [];
let currentText = '';

function setStatus(text, isError = false, isSuccess = false) {
  statusEl.textContent = text || '';
  statusEl.className = 'status';
  if (isError) statusEl.classList.add('error');
  if (isSuccess) statusEl.classList.add('success');
}

function clearResults() {
  currentImages = [];
  currentVideos = [];
  currentText = '';
  imageGridEl.innerHTML = '';
  videoGridEl.innerHTML = '';
  imageCountEl.textContent = '';
  videoCountEl.textContent = '';
  textContentEl.value = '';
  textSectionEl.style.display = 'none';
  resultWrapEl.classList.add('hidden');
  btnDownloadAllEl.disabled = true;
}

function safeText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getImageExt(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const dot = p.lastIndexOf('.');
    if (dot > -1) {
      const ext = p.slice(dot);
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return ext;
    }
  } catch (_) {}
  return '.jpg';
}

function renderResults(images, videos, text) {
  currentImages = Array.isArray(images) ? images : [];
  currentVideos = Array.isArray(videos) ? videos : [];
  currentText = typeof text === 'string' ? text : '';

  if (currentText) {
    textContentEl.value = currentText;
    textSectionEl.style.display = 'block';
  } else {
    textSectionEl.style.display = 'none';
  }

  imageCountEl.textContent = `${currentImages.length} 张`;
  videoCountEl.textContent = `${currentVideos.length} 个`;

  imageGridEl.innerHTML = currentImages.map((img, idx) => {
    const ext = getImageExt(img.url);
    const fileName = `image_${String(idx + 1).padStart(3, '0')}${ext}`;
    const dim = img.width && img.height ? `${img.width}x${img.height}` : '图片';
    return `
      <article class="card">
        <div class="thumb-wrap">
          <img class="thumb" src="${safeText(img.thumbnail || img.url)}" alt="image-${idx + 1}" loading="lazy">
        </div>
        <div class="card-body">
          <div class="name">${safeText(fileName)}</div>
          <div class="meta">${safeText(dim)}</div>
          <button class="btn-dl" data-type="image" data-index="${idx}">下载</button>
        </div>
      </article>
    `;
  }).join('');

  videoGridEl.innerHTML = currentVideos.map((video, idx) => {
    const fileName = `video_${String(idx + 1).padStart(3, '0')}.mp4`;
    const meta = [video.quality, video.width && video.height ? `${video.width}x${video.height}` : '', video.size_str || '']
      .filter(Boolean)
      .join(' · ');
    const poster = video.poster ? `<img class="thumb" src="${safeText(video.poster)}" alt="video-${idx + 1}" loading="lazy">` : '<div class="thumb"></div>';
    return `
      <article class="card">
        <div class="thumb-wrap">
          ${poster}
          <span class="badge">${safeText(video.quality || 'VIDEO')}</span>
        </div>
        <div class="card-body">
          <div class="name">${safeText(fileName)}</div>
          <div class="meta">${safeText(meta || '视频')}</div>
          <button class="btn-dl" data-type="video" data-index="${idx}">下载</button>
        </div>
      </article>
    `;
  }).join('');

  resultWrapEl.classList.remove('hidden');
  btnDownloadAllEl.disabled = currentImages.length + currentVideos.length === 0;
}

async function fetchBlob(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) {
    throw new Error(`下载失败（HTTP ${resp.status}）`);
  }
  return await resp.blob();
}

function triggerBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

async function downloadSingle(type, index) {
  const isImage = type === 'image';
  const list = isImage ? currentImages : currentVideos;
  const item = list[index];
  if (!item) return;

  const fileName = isImage
    ? `image_${String(index + 1).padStart(3, '0')}${getImageExt(item.url)}`
    : `video_${String(index + 1).padStart(3, '0')}.mp4`;
  const url = isImage ? item.url : item.play_url;
  if (!url) {
    setStatus('下载地址为空', true);
    return;
  }

  try {
    setStatus(`正在下载 ${fileName} ...`);
    const blob = await fetchBlob(url);
    triggerBlobDownload(blob, fileName);
    setStatus(`已开始下载 ${fileName}`, false, true);
  } catch (err) {
    setStatus(err?.message || '下载失败', true);
  }
}

async function downloadAllZip() {
  const imageTotal = currentImages.length;
  const videoTotal = currentVideos.length;
  if (imageTotal + videoTotal === 0) {
    setStatus('没有可下载内容', true);
    return;
  }
  if (typeof JSZip === 'undefined') {
    setStatus('ZIP 组件未加载', true);
    return;
  }

  btnDownloadAllEl.disabled = true;
  const zip = new JSZip();
  let success = 0;
  let failed = 0;

  try {
    if (currentText) {
      zip.file('content.txt', currentText);
    }

    for (let i = 0; i < imageTotal; i++) {
      const img = currentImages[i];
      const fileName = `images/image_${String(i + 1).padStart(3, '0')}${getImageExt(img.url)}`;
      if (!img?.url) {
        failed++;
        continue;
      }
      setStatus(`正在打包图片 ${i + 1}/${imageTotal} ...`);
      try {
        const blob = await fetchBlob(img.url);
        zip.file(fileName, blob);
        success++;
      } catch (_) {
        failed++;
      }
    }

    for (let i = 0; i < videoTotal; i++) {
      const video = currentVideos[i];
      const fileName = `videos/video_${String(i + 1).padStart(3, '0')}.mp4`;
      if (!video?.play_url) {
        failed++;
        continue;
      }
      setStatus(`正在打包视频 ${i + 1}/${videoTotal} ...`);
      try {
        const blob = await fetchBlob(video.play_url);
        zip.file(fileName, blob);
        success++;
      } catch (_) {
        failed++;
      }
    }

    if (success === 0) {
      setStatus('打包失败：没有可用资源', true);
      return;
    }

    setStatus('正在生成 ZIP ...');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date();
    const zipName = `zhihu_media_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.zip`;
    triggerBlobDownload(zipBlob, zipName);
    setStatus(`ZIP 已开始下载，成功 ${success} 个，失败 ${failed} 个`, false, true);
  } catch (err) {
    setStatus(err?.message || 'ZIP 下载失败', true);
  } finally {
    btnDownloadAllEl.disabled = false;
  }
}

async function parseZhihuMedia() {
  const url = urlInputEl.value.trim();
  if (!url) {
    setStatus('请输入知乎链接', true);
    return;
  }
  clearResults();
  setStatus('正在解析知乎内容...');
  btnParseEl.disabled = true;

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'ZHIHU_PARSE_MEDIA',
      url
    });
    if (!resp || resp.type !== 'ZHIHU_PARSE_RESULT') {
      setStatus('解析无响应', true);
      return;
    }
    if (!resp.success) {
      setStatus(resp.error || '解析失败', true);
      return;
    }
    const images = resp.data?.images || [];
    const videos = resp.data?.videos || [];
    const text = resp.data?.textContent || '';
    renderResults(images, videos, text);
    const parts = [];
    if (text) parts.push('正文已提取');
    parts.push(`${images.length} 张图片`);
    parts.push(`${videos.length} 个视频`);
    setStatus(`解析完成：${parts.join('，')}`, false, true);
  } catch (err) {
    setStatus(err?.message || '解析失败', true);
  } finally {
    btnParseEl.disabled = false;
  }
}

btnParseEl.addEventListener('click', parseZhihuMedia);
urlInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') parseZhihuMedia();
});

btnOpenMainEl.addEventListener('click', () => {
  window.location.href = chrome.runtime.getURL('dist.html');
});

btnCopyTextEl.addEventListener('click', async () => {
  if (!currentText) return;
  try {
    await navigator.clipboard.writeText(currentText);
    const orig = btnCopyTextEl.textContent;
    btnCopyTextEl.textContent = '已复制';
    setTimeout(() => { btnCopyTextEl.textContent = orig; }, 1500);
  } catch (_) {
    textContentEl.select();
    document.execCommand('copy');
    const orig = btnCopyTextEl.textContent;
    btnCopyTextEl.textContent = '已复制';
    setTimeout(() => { btnCopyTextEl.textContent = orig; }, 1500);
  }
});

btnDownloadAllEl.addEventListener('click', downloadAllZip);

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains('btn-dl')) return;
  const type = target.getAttribute('data-type');
  const index = Number(target.getAttribute('data-index') || '-1');
  if (!type || index < 0) return;
  downloadSingle(type, index);
});
