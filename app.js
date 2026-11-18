lucide.createIcons();

// --- 状態管理 ---
let videoQueue = []; // { id, file, url, creationTimeMs, width, height, duration, trimStart, trimEnd }
let activeIndex = 0;
let convertedResults = []; // { file, blob, url, originalSize, creationTimeMs, ext }

// 相対比率でクロップ位置を保持（複数動画でも同じ比率で切り抜けるようにする）
let cropSettings = {
  enabled: false,
  preset: 'none',
  rx: 0, // 0.0 ~ 1.0
  ry: 0,
  rw: 1,
  rh: 1,
  // 現在表示中の動画でのピクセル値
  x: 0,
  y: 0,
  width: 0,
  height: 0
};

let outputFormat = 'mp4';
let outputQuality = 'medium';
let outputResolution = 'original';

// キャンセル制御
let isCancelled = false;
let currentRecorder = null;

// --- DOM 要素 ---
const videoInput = document.getElementById('videoInput');
const addMoreInput = document.getElementById('addMoreInput');
const selectTitle = document.getElementById('selectTitle');
const selectDesc = document.getElementById('selectDesc');
const selectSection = document.getElementById('selectSection');
const editorSection = document.getElementById('editorSection');
const progressSection = document.getElementById('progressSection');
const resultSection = document.getElementById('resultSection');

const queueCountLabel = document.getElementById('queueCountLabel');
const queueListContainer = document.getElementById('queueListContainer');
const fileMetaName = document.getElementById('fileMetaName');
const fileMetaRes = document.getElementById('fileMetaRes');
const fileMetaSize = document.getElementById('fileMetaSize');
const videoPreview = document.getElementById('videoPreview');

const videoStage = document.getElementById('videoStage');
const cropContainer = document.getElementById('cropContainer');
const cropBox = document.getElementById('cropBox');
const cropStatusText = document.getElementById('cropStatusText');
const cropPresetBtns = document.querySelectorAll('.crop-preset-btn');
const cropAlignControls = document.getElementById('cropAlignControls');
const alignTopBtn = document.getElementById('alignTopBtn');
const alignCenterBtn = document.getElementById('alignCenterBtn');
const alignBottomBtn = document.getElementById('alignBottomBtn');

const trimStartRange = document.getElementById('trimStartRange');
const trimEndRange = document.getElementById('trimEndRange');
const trimStartVal = document.getElementById('trimStartVal');
const trimEndVal = document.getElementById('trimEndVal');
const durationRangeText = document.getElementById('durationRangeText');
const setStartCurrentBtn = document.getElementById('setStartCurrentBtn');
const setEndCurrentBtn = document.getElementById('setEndCurrentBtn');

const formatBtns = document.querySelectorAll('.format-btn');
const qualityBtns = document.querySelectorAll('.quality-btn');
const resolutionSelect = document.getElementById('resolutionSelect');
const videoSettingsCard = document.getElementById('videoSettingsCard');

const startConvertBtn = document.getElementById('startConvertBtn');
const startConvertBtnText = document.getElementById('startConvertBtnText');
const cancelConvertBtn = document.getElementById('cancelConvertBtn');
const reselectBtn = document.getElementById('reselectBtn');

const batchProgressBadge = document.getElementById('batchProgressBadge');
const progressTitleText = document.getElementById('progressTitleText');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressStatusText = document.getElementById('progressStatusText');

const resultSummaryTitle = document.getElementById('resultSummaryTitle');
const resSizeBefore = document.getElementById('resSizeBefore');
const resSizeAfter = document.getElementById('resSizeAfter');
const shareAllBtn = document.getElementById('shareAllBtn');
const shareAllBtnText = document.getElementById('shareAllBtnText');
const resultItemsList = document.getElementById('resultItemsList');
const resetBtn = document.getElementById('resetBtn');

// 1904-01-01 00:00:00 UTC と 1970-01-01 00:00:00 UTC の秒数差 (MP4/QuickTime規格)
const MAC_EPOCH_OFFSET_SEC = 2082844800;

function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatDateJP(ms) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

function getPreservedFileName(originalName, newExt) {
  if (!originalName) return `video.${newExt}`;
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot > 0 ? originalName.substring(0, lastDot) : originalName;
  return `${baseName}.${newExt}`;
}

function findMvhdCreationTimeInBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const len = bytes.length;

  for (let i = 4; i < len - 24; i++) {
    if (
      bytes[i] === 0x6d &&
      bytes[i + 1] === 0x76 &&
      bytes[i + 2] === 0x68 &&
      bytes[i + 3] === 0x64
    ) {
      const boxSize = view.getUint32(i - 4, false);
      const version = bytes[i + 4];
      if (boxSize >= 96 && boxSize <= 512 && (version === 0 || version === 1)) {
        let macSec = 0;
        if (version === 0) {
          macSec = view.getUint32(i + 8, false);
        } else {
          const high = view.getUint32(i + 8, false);
          const low = view.getUint32(i + 12, false);
          macSec = high * 4294967296 + low;
        }
        if (macSec > MAC_EPOCH_OFFSET_SEC + 315532800) {
          const unixMs = (macSec - MAC_EPOCH_OFFSET_SEC) * 1000;
          if (unixMs <= Date.now() + 86400000 * 365) {
            return unixMs;
          }
        }
      }
    }
  }
  return null;
}

async function extractOriginalCreationDate(file) {
  try {
    const chunkSize = 8 * 1024 * 1024;
    const headBuffer = await file.slice(0, Math.min(file.size, chunkSize)).arrayBuffer();
    const headTime = findMvhdCreationTimeInBuffer(headBuffer);
    if (headTime) return headTime;

    if (file.size > chunkSize) {
      const tailStart = Math.max(0, file.size - chunkSize);
      const tailBuffer = await file.slice(tailStart, file.size).arrayBuffer();
      const tailTime = findMvhdCreationTimeInBuffer(tailBuffer);
      if (tailTime) return tailTime;
    }
  } catch (e) {
    console.warn('Metadata date read skipped:', e);
  }
  return file.lastModified || Date.now();
}

async function patchMp4CreationTime(mp4Blob, targetTimeMs) {
  try {
    const buffer = await mp4Blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const len = bytes.length;

    const targetMacSec = Math.max(0, Math.floor(targetTimeMs / 1000) + MAC_EPOCH_OFFSET_SEC);

    for (let i = 4; i < len - 24; i++) {
      const isMvhd = bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
      const isTkhd = bytes[i] === 0x74 && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
      const isMdhd = bytes[i] === 0x6d && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;

      if (isMvhd || isTkhd || isMdhd) {
        const boxSize = view.getUint32(i - 4, false);
        const version = bytes[i + 4];
        if (boxSize >= 24 && boxSize <= 512 && (version === 0 || version === 1)) {
          if (version === 0) {
            view.setUint32(i + 8, targetMacSec, false);
            view.setUint32(i + 12, targetMacSec, false);
          } else {
            view.setUint32(i + 8, 0, false);
            view.setUint32(i + 12, targetMacSec, false);
            view.setUint32(i + 16, 0, false);
            view.setUint32(i + 20, targetMacSec, false);
          }
        }
      }
    }

    return new Blob([buffer], { type: mp4Blob.type || 'video/mp4' });
  } catch (e) {
    console.warn('MP4 timestamp patch skipped:', e);
    return mp4Blob;
  }
}

// 1本の動画ファイルからメタデータを読み取ってキューアイテムを生成する
async function createQueueItem(file) {
  const creationTimeMs = await extractOriginalCreationDate(file);
  const url = URL.createObjectURL(file);

  const meta = await new Promise((resolve) => {
    const tempVideo = document.createElement('video');
    tempVideo.muted = true;
    tempVideo.playsInline = true;
    tempVideo.preload = 'metadata';
    tempVideo.src = url;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({
        width: tempVideo.videoWidth || 1920,
        height: tempVideo.videoHeight || 1080,
        duration: tempVideo.duration || 10
      });
    };

    tempVideo.onloadedmetadata = finish;
    tempVideo.onloadeddata = finish;
    setTimeout(finish, 1200);
  });

  return {
    id: 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    file,
    url,
    creationTimeMs,
    width: meta.width,
    height: meta.height,
    duration: meta.duration,
    trimStart: 0,
    trimEnd: meta.duration
  };
}

// --- 複数動画の選択＆追加 ---
async function handleFilesSelected(fileList, isAdding = false) {
  if (!fileList || fileList.length === 0) return;

  if (!isAdding) {
    if (selectTitle) selectTitle.textContent = `${fileList.length}本の動画を読み込み中...`;
    if (selectDesc) selectDesc.textContent = 'しばらくお待ちください';
    videoQueue = [];
  }

  for (let i = 0; i < fileList.length; i++) {
    const item = await createQueueItem(fileList[i]);
    videoQueue.push(item);
  }

  if (!isAdding) {
    activeIndex = 0;
    selectSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
  } else {
    activeIndex = videoQueue.length - 1;
  }

  renderQueueUI();
  loadActiveItemIntoEditor();
}

videoInput.addEventListener('change', (e) => {
  handleFilesSelected(e.target.files, false);
});

addMoreInput.addEventListener('change', (e) => {
  handleFilesSelected(e.target.files, true);
  addMoreInput.value = '';
});

function renderQueueUI() {
  const count = videoQueue.length;
  queueCountLabel.textContent = `選択中の動画 (${count}本)`;
  startConvertBtnText.textContent = count > 1 ? `連続変換を開始する (全 ${count} 本)` : '変換を開始する';

  queueListContainer.innerHTML = '';
  videoQueue.forEach((item, idx) => {
    const isSelected = idx === activeIndex;
    const chip = document.createElement('div');
    chip.className = isSelected
      ? 'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-medium cursor-pointer transition-all shadow'
      : 'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs cursor-pointer transition-all';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'max-w-[120px] truncate';
    labelSpan.textContent = `${idx + 1}. ${item.file.name}`;
    labelSpan.addEventListener('click', () => {
      activeIndex = idx;
      renderQueueUI();
      loadActiveItemIntoEditor();
    });

    chip.appendChild(labelSpan);

    // 2本以上ある場合は個別削除ボタンを表示
    if (count > 1) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ml-1 w-4 h-4 rounded-full bg-black/30 hover:bg-black/50 flex items-center justify-center text-[10px]';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        videoQueue.splice(idx, 1);
        if (activeIndex >= videoQueue.length) activeIndex = videoQueue.length - 1;
        renderQueueUI();
        loadActiveItemIntoEditor();
      });
      chip.appendChild(delBtn);
    }

    queueListContainer.appendChild(chip);
  });

  lucide.createIcons();
}

function getActiveItem() {
  return videoQueue[activeIndex] || null;
}

function loadActiveItemIntoEditor() {
  const item = getActiveItem();
  if (!item) return;

  fileMetaName.textContent = `${item.file.name} (${formatDateJP(item.creationTimeMs)})`;
  fileMetaRes.textContent = `${item.width}×${item.height}`;
  fileMetaSize.textContent = formatBytes(item.file.size);

  videoPreview.muted = true;
  videoPreview.playsInline = true;
  videoPreview.setAttribute('playsinline', '');
  videoPreview.setAttribute('webkit-playsinline', '');
  videoPreview.src = item.url;

  const syncUI = () => {
    // 実際のメタデータで補正
    if (videoPreview.videoWidth) item.width = videoPreview.videoWidth;
    if (videoPreview.videoHeight) item.height = videoPreview.videoHeight;
    if (videoPreview.duration && isFinite(videoPreview.duration)) {
      if (item.trimEnd === item.duration) item.trimEnd = videoPreview.duration;
      item.duration = videoPreview.duration;
    }

    fileMetaRes.textContent = `${item.width}×${item.height}`;

    trimStartRange.max = item.duration;
    trimStartRange.value = item.trimStart;
    trimEndRange.max = item.duration;
    trimEndRange.value = item.trimEnd;

    updateTrimLabels();

    // 現在のクロップ設定をこの動画の解像度に合わせて反映
    if (cropSettings.enabled) {
      updateCropBoxFromRatio();
    } else {
      applyCropPreset('none');
    }
  };

  videoPreview.onloadedmetadata = syncUI;
  setTimeout(syncUI, 200);
}

reselectBtn.addEventListener('click', () => {
  videoInput.value = '';
  videoQueue = [];
  if (selectTitle) selectTitle.textContent = '写真・動画を選択（複数可）';
  if (selectDesc) selectDesc.textContent = 'カメラロールから1本または複数の動画をまとめて選択';
  editorSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  selectSection.classList.remove('hidden');
});

// --- トリミング設定 ---
function updateTrimLabels() {
  const item = getActiveItem();
  if (!item) return;
  trimStartVal.textContent = formatTime(item.trimStart);
  trimEndVal.textContent = formatTime(item.trimEnd);
  const diff = Math.max(0.1, item.trimEnd - item.trimStart);
  durationRangeText.textContent = `${formatTime(item.trimStart)} - ${formatTime(item.trimEnd)} (${diff.toFixed(1)}秒)`;
}

trimStartRange.addEventListener('input', (e) => {
  const item = getActiveItem();
  if (!item) return;
  const val = parseFloat(e.target.value);
  if (val >= item.trimEnd) {
    item.trimStart = Math.max(0, item.trimEnd - 0.5);
    trimStartRange.value = item.trimStart;
  } else {
    item.trimStart = val;
  }
  videoPreview.currentTime = item.trimStart;
  updateTrimLabels();
});

trimEndRange.addEventListener('input', (e) => {
  const item = getActiveItem();
  if (!item) return;
  const val = parseFloat(e.target.value);
  if (val <= item.trimStart) {
    item.trimEnd = Math.min(item.duration, item.trimStart + 0.5);
    trimEndRange.value = item.trimEnd;
  } else {
    item.trimEnd = val;
  }
  videoPreview.currentTime = item.trimEnd;
  updateTrimLabels();
});

setStartCurrentBtn.addEventListener('click', () => {
  const item = getActiveItem();
  if (!item) return;
  const cur = videoPreview.currentTime;
  if (cur < item.trimEnd) {
    item.trimStart = cur;
    trimStartRange.value = cur;
    updateTrimLabels();
  }
});

setEndCurrentBtn.addEventListener('click', () => {
  const item = getActiveItem();
  if (!item) return;
  const cur = videoPreview.currentTime;
  if (cur > item.trimStart) {
    item.trimEnd = cur;
    trimEndRange.value = cur;
    updateTrimLabels();
  }
});

// --- クロップ（画面切り抜き） ---
function getStageScale() {
  const item = getActiveItem();
  const w = item ? item.width : 1920;
  const h = item ? item.height : 1080;
  const stageW = videoStage.clientWidth || 300;
  const stageH = videoStage.clientHeight || 200;
  return {
    scaleX: w / stageW,
    scaleY: h / stageH,
    stageW,
    stageH,
    videoW: w,
    videoH: h
  };
}

function updateCropBoxUI(pxX, pxY, pxW, pxH) {
  const { scaleX, scaleY, videoW, videoH } = getStageScale();

  const uiLeft = pxX / scaleX;
  const uiTop = pxY / scaleY;
  const uiWidth = pxW / scaleX;
  const uiHeight = pxH / scaleY;

  cropBox.style.left = `${uiLeft}px`;
  cropBox.style.top = `${uiTop}px`;
  cropBox.style.width = `${uiWidth}px`;
  cropBox.style.height = `${uiHeight}px`;

  cropSettings.x = Math.round(pxX);
  cropSettings.y = Math.round(pxY);
  cropSettings.width = Math.round(pxW);
  cropSettings.height = Math.round(pxH);

  // 複数動画でも同じ比率で適用できるよう相対比率(0~1)を保存
  cropSettings.rx = pxX / (videoW || 1);
  cropSettings.ry = pxY / (videoH || 1);
  cropSettings.rw = pxW / (videoW || 1);
  cropSettings.rh = pxH / (videoH || 1);

  cropStatusText.textContent = `${cropSettings.width} × ${cropSettings.height}`;
}

function updateCropBoxFromRatio() {
  const item = getActiveItem();
  if (!item) return;
  const pxX = item.width * cropSettings.rx;
  const pxY = item.height * cropSettings.ry;
  const pxW = item.width * cropSettings.rw;
  const pxH = item.height * cropSettings.rh;
  updateCropBoxUI(pxX, pxY, pxW, pxH);
}

function applyCropPreset(preset) {
  cropSettings.preset = preset;
  const item = getActiveItem();
  const w = item ? item.width : 1920;
  const h = item ? item.height : 1080;

  cropPresetBtns.forEach(btn => {
    if (btn.dataset.preset === preset) {
      btn.className = 'crop-preset-btn active bg-blue-600 text-white font-medium py-2 rounded-xl transition-all';
    } else {
      btn.className = 'crop-preset-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-2 rounded-xl transition-all';
    }
  });

  if (preset === 'none') {
    cropSettings.enabled = false;
    cropSettings.rx = 0;
    cropSettings.ry = 0;
    cropSettings.rw = 1;
    cropSettings.rh = 1;
    cropContainer.classList.add('hidden');
    cropAlignControls.classList.add('hidden');
    cropStatusText.textContent = '全体 (なし)';
    return;
  }

  cropSettings.enabled = true;
  cropContainer.classList.remove('hidden');
  cropAlignControls.classList.remove('hidden');

  let targetW = w;
  let targetH = h;
  let targetX = 0;
  let targetY = 0;

  if (preset === 'iphone-bar') {
    const topCut = Math.round(h * 0.07);
    const bottomCut = Math.round(h * 0.04);
    targetY = topCut;
    targetH = h - topCut - bottomCut;
    targetX = 0;
    targetW = w;
  } else if (preset === '9-16') {
    targetW = Math.min(w, Math.round(h * (9 / 16)));
    targetH = Math.round(targetW * (16 / 9));
    targetX = Math.round((w - targetW) / 2);
    targetY = Math.round((h - targetH) / 2);
  } else if (preset === '16-9') {
    targetH = Math.min(h, Math.round(w * (9 / 16)));
    targetW = Math.round(targetH * (16 / 9));
    targetX = Math.round((w - targetW) / 2);
    targetY = Math.round((h - targetH) / 2);
  } else if (preset === '1-1') {
    const side = Math.min(w, h);
    targetW = side;
    targetH = side;
    targetX = Math.round((w - side) / 2);
    targetY = Math.round((h - side) / 2);
  } else if (preset === 'custom') {
    targetW = Math.round(w * 0.85);
    targetH = Math.round(h * 0.85);
    targetX = Math.round((w - targetW) / 2);
    targetY = Math.round((h - targetH) / 2);
  }

  updateCropBoxUI(targetX, targetY, targetW, targetH);
}

cropPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => applyCropPreset(btn.dataset.preset));
});

alignTopBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  updateCropBoxUI(cropSettings.x, 0, cropSettings.width, cropSettings.height);
});

alignCenterBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  const { videoW, videoH } = getStageScale();
  const centerY = Math.round((videoH - cropSettings.height) / 2);
  const centerX = Math.round((videoW - cropSettings.width) / 2);
  updateCropBoxUI(centerX, centerY, cropSettings.width, cropSettings.height);
});

alignBottomBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  const { videoH } = getStageScale();
  const bottomY = Math.max(0, videoH - cropSettings.height);
  updateCropBoxUI(cropSettings.x, bottomY, cropSettings.width, cropSettings.height);
});

// クロップ枠のタッチ＆ドラッグ
let isDragging = false;
let touchStartX = 0;
let touchStartY = 0;
let initialCropX = 0;
let initialCropY = 0;

function handleDragStart(clientX, clientY) {
  isDragging = true;
  touchStartX = clientX;
  touchStartY = clientY;
  initialCropX = cropSettings.x;
  initialCropY = cropSettings.y;
}

function handleDragMove(clientX, clientY) {
  if (!isDragging) return;
  const { scaleX, scaleY, videoW, videoH } = getStageScale();
  const deltaX = (clientX - touchStartX) * scaleX;
  const deltaY = (clientY - touchStartY) * scaleY;

  let newX = Math.max(0, Math.min(videoW - cropSettings.width, initialCropX + deltaX));
  let newY = Math.max(0, Math.min(videoH - cropSettings.height, initialCropY + deltaY));

  updateCropBoxUI(newX, newY, cropSettings.width, cropSettings.height);
}

function handleDragEnd() {
  isDragging = false;
}

cropBox.addEventListener('mousedown', (e) => handleDragStart(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => { if (isDragging) handleDragMove(e.clientX, e.clientY); });
window.addEventListener('mouseup', () => handleDragEnd());

cropBox.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    e.preventDefault();
    handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  if (isDragging && e.touches.length === 1) {
    e.preventDefault();
    handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });

window.addEventListener('touchend', () => handleDragEnd());
window.addEventListener('touchcancel', () => handleDragEnd());

// --- 出力フォーマット ---
formatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    outputFormat = btn.dataset.format;
    formatBtns.forEach(b => {
      b.className = (b === btn)
        ? 'format-btn active bg-blue-600 text-white font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all'
        : 'format-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all';
    });

    if (outputFormat === 'wav') {
      videoSettingsCard.classList.add('hidden');
    } else {
      videoSettingsCard.classList.remove('hidden');
    }
  });
});

qualityBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    outputQuality = btn.dataset.quality;
    qualityBtns.forEach(b => {
      if (b === btn) {
        b.className = 'quality-btn active px-3 py-1 rounded-lg text-white font-medium bg-blue-600 transition-all';
      } else {
        b.className = 'quality-btn px-3 py-1 rounded-lg text-zinc-400 transition-all';
      }
    });
  });
});

resolutionSelect.addEventListener('change', (e) => {
  outputResolution = e.target.value;
});

// 変換停止ボタン
cancelConvertBtn.addEventListener('click', () => {
  isCancelled = true;
  if (videoPreview) videoPreview.pause();
  if (currentRecorder && currentRecorder.state !== 'inactive') {
    try { currentRecorder.stop(); } catch (e) {}
  }
  progressSection.classList.add('hidden');
  editorSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  loadActiveItemIntoEditor();
});

// --- 連続変換（バッチ実行） ---
startConvertBtn.addEventListener('click', async () => {
  if (videoQueue.length === 0) return;

  isCancelled = false;
  convertedResults = [];

  editorSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  lucide.createIcons();

  try {
    for (let i = 0; i < videoQueue.length; i++) {
      if (isCancelled) break;

      const item = videoQueue[i];
      batchProgressBadge.textContent = `${i + 1} / ${videoQueue.length} 本目`;
      progressTitleText.textContent = `${item.file.name} を変換中...`;
      progressBar.style.width = '0%';
      progressPercent.textContent = '0%';
      progressStatusText.textContent = 'フレームを切り取り＆エンコード中...';

      let rawBlob = null;
      let finalExt = outputFormat;

      if (outputFormat === 'gif') {
        rawBlob = await convertItemToGIF(item);
        finalExt = 'gif';
      } else if (outputFormat === 'wav') {
        rawBlob = await convertItemToAudio(item);
        finalExt = 'wav';
      } else {
        const res = await convertItemToVideo(item);
        rawBlob = res.blob;
        finalExt = res.ext;
      }

      if (isCancelled || !rawBlob) break;

      // MP4の場合は元の撮影日時をバイナリヘッダ(mvhd/tkhd/mdhd)に書き込む
      if (finalExt === 'mp4') {
        progressStatusText.textContent = '元の撮影日時・タイトルを書き込み中...';
        rawBlob = await patchMp4CreationTime(rawBlob, item.creationTimeMs);
      }

      const finalFileName = getPreservedFileName(item.file.name, finalExt);
      const convertedFile = new File([rawBlob], finalFileName, {
        type: rawBlob.type,
        lastModified: item.creationTimeMs
      });

      convertedResults.push({
        file: convertedFile,
        blob: rawBlob,
        url: URL.createObjectURL(convertedFile),
        originalSize: item.file.size,
        creationTimeMs: item.creationTimeMs,
        ext: finalExt
      });
    }

    if (isCancelled) return;

    showBatchResults();
  } catch (err) {
    if (isCancelled) return;
    console.error('Batch conversion failed:', err);
    alert('変換処理中にエラーが発生しました: ' + (err.message || err));
    progressSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
    loadActiveItemIntoEditor();
  }
});

// 1本の動画をクロップ＆トリミングしてMP4/WebMにする
async function convertItemToVideo(item) {
  videoPreview.src = item.url;
  videoPreview.muted = true;
  await new Promise((r) => {
    videoPreview.onloadedmetadata = r;
    videoPreview.oncanplay = r;
    setTimeout(r, 400);
  });

  const vw = videoPreview.videoWidth || item.width || 1920;
  const vh = videoPreview.videoHeight || item.height || 1080;

  // クロップ座標を比率(rx, ry, rw, rh)から各動画の解像度に合わせて算出
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (cropSettings.enabled) {
    sx = Math.max(0, Math.round(vw * cropSettings.rx));
    sy = Math.max(0, Math.round(vh * cropSettings.ry));
    sw = Math.min(vw - sx, Math.round(vw * cropSettings.rw));
    sh = Math.min(vh - sy, Math.round(vh * cropSettings.rh));
  }

  let outW = sw;
  let outH = sh;
  if (outputResolution !== 'original') {
    const target = parseInt(outputResolution);
    if (sw >= sh) {
      outW = Math.round(target * (sw / sh));
      outH = target;
    } else {
      outW = target;
      outH = Math.round(target * (sh / sw));
    }
  }
  outW = Math.max(2, Math.floor(outW / 2) * 2);
  outH = Math.max(2, Math.floor(outH / 2) * 2);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  let bitrate = 4000000;
  if (outputQuality === 'high') bitrate = 8000000;
  if (outputQuality === 'small') bitrate = 1500000;

  const canvasStream = canvas.captureStream(30);

  let mimeType = 'video/mp4';
  if (!MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') ? 'video/mp4;codecs=avc1' : 'video/webm';
  }

  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: bitrate
  });
  currentRecorder = recorder;

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const startSec = item.trimStart || 0;
  const endSec = item.trimEnd || item.duration;
  const totalDuration = Math.max(0.2, endSec - startSec);

  videoPreview.currentTime = startSec;
  await new Promise((r) => {
    videoPreview.onseeked = r;
    setTimeout(r, 300);
  });

  recorder.start(100);
  try {
    await videoPreview.play();
  } catch (e) {
    videoPreview.muted = true;
    await videoPreview.play();
  }

  let isRunning = true;
  function renderFrame() {
    if (!isRunning || isCancelled) {
      isRunning = false;
      return;
    }

    ctx.drawImage(videoPreview, sx, sy, sw, sh, 0, 0, outW, outH);

    const currentSec = videoPreview.currentTime;
    const progress = (currentSec - startSec) / totalDuration;
    const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
    progressBar.style.width = `${pct}%`;
    progressPercent.textContent = `${pct}%`;

    if (currentSec >= endSec || videoPreview.ended) {
      isRunning = false;
      videoPreview.pause();
      if (!isCancelled && recorder.state !== 'inactive') recorder.stop();
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  renderFrame();

  await new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  const finalExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return {
    blob: new Blob(chunks, { type: mimeType }),
    ext: finalExt
  };
}

// GIF変換
function convertItemToGIF(item) {
  return new Promise((resolve, reject) => {
    const startSec = item.trimStart || 0;
    const duration = Math.min(10, (item.trimEnd || item.duration) - startSec);

    const sx = cropSettings.enabled ? Math.round(item.width * cropSettings.rx) : 0;
    const sy = cropSettings.enabled ? Math.round(item.height * cropSettings.ry) : 0;
    const sw = cropSettings.enabled ? Math.round(item.width * cropSettings.rw) : item.width;
    const sh = cropSettings.enabled ? Math.round(item.height * cropSettings.rh) : item.height;

    gifshot.createGIF({
      video: [item.url],
      offset: startSec,
      duration: duration,
      numFrames: Math.max(5, Math.round(duration * 10)),
      frameDuration: 1,
      sampleInterval: 10,
      videoX: sx,
      videoY: sy,
      videoWidth: sw,
      videoHeight: sh,
      gifWidth: 400,
      gifHeight: Math.round(400 * (sh / (sw || 1))),
      progressCallback: (captureProgress) => {
        const pct = Math.round(captureProgress * 100);
        progressBar.style.width = `${pct}%`;
        progressPercent.textContent = `${pct}%`;
      }
    }, (obj) => {
      if (!obj.error) {
        const byteCharacters = atob(obj.image.split(',')[1]);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        resolve(new Blob([new Uint8Array(byteNumbers)], { type: 'image/gif' }));
      } else {
        reject(new Error(obj.error));
      }
    });
  });
}

// 音声抽出 (WAV)
async function convertItemToAudio(item) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const response = await fetch(item.url);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const startSec = item.trimStart || 0;
  const endSec = item.trimEnd || item.duration;
  const startSample = Math.floor(startSec * audioBuffer.sampleRate);
  const endSample = Math.floor(endSec * audioBuffer.sampleRate);
  const length = Math.max(1000, endSample - startSample);

  const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, length, audioBuffer.sampleRate);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    trimmed.copyToChannel(audioBuffer.getChannelData(ch).subarray(startSample, endSample), ch, 0);
  }

  return audioBufferToWavBlob(trimmed);
}

function audioBufferToWavBlob(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const out = new DataView(new ArrayBuffer(length));
  let pos = 0;

  function setUint16(data) { out.setUint16(pos, data, true); pos += 2; }
  function setUint32(data) { out.setUint32(pos, data, true); pos += 4; }

  out.setUint32(0, 0x46464952, true);
  out.setUint32(4, length - 8, true);
  out.setUint32(8, 0x45564157, true);
  out.setUint32(12, 0x20746d66, true);
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  out.setUint32(pos, 0x61746164, true); pos += 4;
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      let sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      out.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      pos += 2;
    }
  }

  return new Blob([out.buffer], { type: 'audio/wav' });
}

// --- 完了画面の表示（一括保存＆個別カード） ---
function showBatchResults() {
  progressSection.classList.add('hidden');
  resultSection.classList.remove('hidden');

  const count = convertedResults.length;
  resultSummaryTitle.textContent = count > 1 ? `全 ${count} 本の変換が完了しました！` : '変換が完了しました！';
  shareAllBtnText.textContent = count > 1
    ? `全 ${count} 本をまとめて写真アプリに保存`
    : '写真アプリに保存（「ビデオを保存」を選択）';

  const totalBefore = convertedResults.reduce((acc, r) => acc + r.originalSize, 0);
  const totalAfter = convertedResults.reduce((acc, r) => acc + r.blob.size, 0);
  const savedPct = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;

  resSizeBefore.textContent = formatBytes(totalBefore);
  resSizeAfter.textContent = `${formatBytes(totalAfter)} (${savedPct}% 削減)`;

  resultItemsList.innerHTML = '';

  convertedResults.forEach((res, idx) => {
    const card = document.createElement('div');
    card.className = 'w-full bg-zinc-950/90 border border-zinc-800 rounded-2xl p-3 flex flex-col gap-2.5';

    // ファイル名＆撮影日時ヘッダー
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between text-xs';
    header.innerHTML = `
      <span class="font-semibold text-zinc-200 truncate max-w-[55%]">${idx + 1}. ${res.file.name}</span>
      <span class="text-[11px] font-mono text-zinc-400">📅 ${formatDateJP(res.creationTimeMs)}</span>
    `;
    card.appendChild(header);

    // プレビュー
    const previewWrap = document.createElement('div');
    previewWrap.className = 'w-full bg-black rounded-xl overflow-hidden border border-zinc-800/80 flex items-center justify-center';
    if (res.ext === 'gif') {
      const img = document.createElement('img');
      img.src = res.url;
      img.className = 'max-h-[220px] object-contain';
      previewWrap.appendChild(img);
    } else if (res.ext === 'wav') {
      const aud = document.createElement('audio');
      aud.src = res.url;
      aud.controls = true;
      aud.className = 'w-full p-2';
      previewWrap.appendChild(aud);
    } else {
      const vid = document.createElement('video');
      vid.src = res.url;
      vid.playsInline = true;
      vid.controls = true;
      vid.className = 'w-full max-h-[220px] object-contain';
      previewWrap.appendChild(vid);
    }
    card.appendChild(previewWrap);

    // 個別アクションボタン
    const actions = document.createElement('div');
    actions.className = 'grid grid-cols-2 gap-2 text-xs';

    const singleShareBtn = document.createElement('button');
    singleShareBtn.type = 'button';
    singleShareBtn.className = 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-medium py-2 rounded-xl flex items-center justify-center gap-1.5';
    singleShareBtn.innerHTML = '<i data-lucide="image-down" class="w-3.5 h-3.5"></i><span>写真に保存</span>';
    singleShareBtn.addEventListener('click', async () => {
      if (navigator.canShare && navigator.canShare({ files: [res.file] })) {
        try {
          await navigator.share({ files: [res.file] });
        } catch (err) {
          if (err.name !== 'AbortError') console.error(err);
        }
      } else {
        singleDlLink.click();
      }
    });

    const singleDlLink = document.createElement('a');
    singleDlLink.href = res.url;
    singleDlLink.download = res.file.name;
    singleDlLink.className = 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2 rounded-xl flex items-center justify-center gap-1.5';
    singleDlLink.innerHTML = `<i data-lucide="folder-down" class="w-3.5 h-3.5"></i><span>ファイル保存 (${formatBytes(res.blob.size)})</span>`;

    actions.appendChild(singleShareBtn);
    actions.appendChild(singleDlLink);
    card.appendChild(actions);

    resultItemsList.appendChild(card);
  });

  lucide.createIcons();
}

// 一括で写真アプリに保存（iOS Safariは files 配列で複数動画の一括保存に完全対応）
shareAllBtn.addEventListener('click', async () => {
  if (convertedResults.length === 0) return;
  const allFiles = convertedResults.map((r) => r.file);

  if (navigator.canShare && navigator.canShare({ files: allFiles })) {
    try {
      await navigator.share({
        files: allFiles
      });
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Batch share failed:', err);
    }
  } else {
    // 非対応ブラウザ（PC等）では順番にダウンロード
    convertedResults.forEach((r) => {
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.file.name;
      a.click();
    });
  }
});

resetBtn.addEventListener('click', () => {
  resultSection.classList.add('hidden');
  selectSection.classList.remove('hidden');
  videoInput.value = '';
  videoQueue = [];
  convertedResults = [];
  if (selectTitle) selectTitle.textContent = '写真・動画を選択（複数可）';
  if (selectDesc) selectDesc.textContent = 'カメラロールから1本または複数の動画をまとめて選択';
});
