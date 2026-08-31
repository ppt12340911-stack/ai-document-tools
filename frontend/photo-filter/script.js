// ============================================
// 相片智能篩選 - 前端邏輯
// ============================================

const dropZone    = document.getElementById('dropZone');
const fileInput   = document.getElementById('fileInput');
const fileCounter = document.getElementById('fileCounter');
const fileCountTx = document.getElementById('fileCountText');
const clearBtn    = document.getElementById('clearBtn');
const paramsPanel = document.getElementById('paramsPanel');
const actionBar   = document.getElementById('actionBar');
const analyzeBtn  = document.getElementById('analyzeBtn');
const loadingBar  = document.getElementById('loadingBar');
const loadingText = document.getElementById('loadingText');
const summaryBar  = document.getElementById('summaryBar');
const resultsGrid = document.getElementById('resultsGrid');
const reanalyzeBar= document.getElementById('reanalyzeBar');
const exportBtn   = document.getElementById('exportBtn');
const downloadZipBtn = document.getElementById('downloadZipBtn');

let selectedFiles = [];
let targetFile = null;
let analysisResults = [];
let sessionId = null;
let currentFilter = 'all';

// 防誤關閉
window.isProcessing = false;
window.addEventListener('beforeunload', (e) => {
    if (window.isProcessing) {
        e.preventDefault();
        e.returnValue = '系統正在分析中，離開將會中斷任務，確定要離開嗎？';
    }
});

// ===== Drag & Drop =====
let dragCount = 0;
['dragenter','dragover','dragleave','drop'].forEach(evt =>
    dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); })
);
dropZone.addEventListener('dragenter', () => { dragCount++; if(dragCount===1) dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => { dragCount--; if(dragCount===0) dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', (e) => {
    dragCount = 0; dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e => handleFiles(e.target.files));

// ===== Target Handling =====
const targetZone = document.getElementById('targetZone');
const targetInput = document.getElementById('targetInput');
const targetPreview = document.getElementById('targetPreview');
const clearTargetBtn = document.getElementById('clearTargetBtn');

targetInput.addEventListener('change', e => {
    if (e.target.files && e.target.files.length > 0) {
        setTargetFile(e.target.files[0]);
    }
});

function setTargetFile(file) {
    targetFile = file;
    targetPreview.src = URL.createObjectURL(targetFile);
    targetPreview.style.display = 'block';
    clearTargetBtn.style.display = 'block';
    targetZone.classList.add('has-target');
    document.getElementById('targetHint').textContent = "已載入：" + targetFile.name;
}

// Target Drag & Drop
let targetDragCount = 0;
['dragenter','dragover','dragleave','drop'].forEach(evt =>
    targetZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); })
);
targetZone.addEventListener('dragenter', () => { targetDragCount++; if(targetDragCount===1) targetZone.classList.add('dragover'); });
targetZone.addEventListener('dragleave', () => { targetDragCount--; if(targetDragCount===0) targetZone.classList.remove('dragover'); });
targetZone.addEventListener('drop', (e) => {
    targetDragCount = 0; targetZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const f = e.dataTransfer.files[0];
        const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
        if (['.jpg','.jpeg','.png','.webp'].includes(ext)) {
            setTargetFile(f);
        }
    }
});

// Paste support
let isTargetHovered = false;
targetZone.addEventListener('mouseenter', () => isTargetHovered = true);
targetZone.addEventListener('mouseleave', () => isTargetHovered = false);

document.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let pastedFiles = [];
    for (let index in items) {
        let item = items[index];
        if (item.kind === 'file' && item.type.indexOf('image/') !== -1) {
            let blob = item.getAsFile();
            // Assign a filename to the pasted image
            let ext = item.type.split('/')[1] || 'png';
            let file = new File([blob], `pasted_image_${Date.now()}.${ext}`, {type: item.type});
            pastedFiles.push(file);
        }
    }
    
    if (pastedFiles.length > 0) {
        if (isTargetHovered) {
            setTargetFile(pastedFiles[0]);
        } else {
            handleFiles(pastedFiles);
        }
    }
});

clearTargetBtn.addEventListener('click', () => {
    targetFile = null;
    targetPreview.src = '';
    targetPreview.style.display = 'none';
    clearTargetBtn.style.display = 'none';
    targetZone.classList.remove('has-target');
    document.getElementById('targetHint').textContent = "點擊或拖曳想尋找的人的大頭貼至此";
    targetInput.value = '';
});

// ===== File Handling =====
function handleFiles(files) {
    const valid = ['.zip','.jpg','.jpeg','.png','.bmp','.webp'];
    for (const f of files) {
        const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
        if (valid.includes(ext) && !selectedFiles.some(x => x.name === f.name && x.size === f.size)) {
            selectedFiles.push(f);
        }
    }
    updateUI();
}

function updateUI() {
    const n = selectedFiles.length;
    let hasZip = selectedFiles.some(f => f.name.toLowerCase().endsWith('.zip'));
    if (n > 0) {
        fileCounter.style.display = 'flex';
        fileCountTx.textContent = hasZip ? `已選取 ${n} 個檔案 (包含壓縮包)` : `已選取 ${n} 張圖片`;
        paramsPanel.style.display = 'block';
        actionBar.style.display = 'block';
    } else {
        fileCounter.style.display = 'none';
        paramsPanel.style.display = 'none';
        actionBar.style.display = 'none';
        summaryBar.style.display = 'none';
        resultsGrid.innerHTML = '';
        reanalyzeBar.style.display = 'none';
    }
}

clearBtn.addEventListener('click', () => {
    selectedFiles = [];
    analysisResults = [];
    sessionId = null;
    fileInput.value = '';
    updateUI();
});

// ===== Sliders =====
const sliders = [
    ['blurThreshold', 'blurVal'],
    ['minBrightness', 'minBriVal'],
    ['maxBrightness', 'maxBriVal'],
    ['hashThreshold', 'hashVal'],
];
sliders.forEach(([id, valId]) => {
    const el = document.getElementById(id);
    const disp = document.getElementById(valId);
    el.addEventListener('input', () => { disp.textContent = el.value; });
});

// ===== Analyze =====
analyzeBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;

    analyzeBtn.disabled = true;
    loadingBar.style.display = 'block';
    summaryBar.style.display = 'none';
    resultsGrid.innerHTML = '';
    reanalyzeBar.style.display = 'none';

    window.isProcessing = true;
    let secs = 0;
    const hasZip = selectedFiles.some(f => f.name.toLowerCase().endsWith('.zip'));
    const baseText = hasZip ? `正在處理並解壓縮檔案，分析圖片中，請稍候...` : `正在分析 ${selectedFiles.length} 張圖片，請稍候...`;
    loadingText.textContent = baseText;
    const timer = setInterval(() => { secs++; loadingText.textContent = `${baseText} (已耗時: ${secs} 秒)`; }, 1000);

    try {
        const formData = new FormData();
        selectedFiles.forEach(f => formData.append('files', f));
        if (targetFile) {
            formData.append('target_face_file', targetFile);
        }
        formData.append('blur_threshold',  document.getElementById('blurThreshold').value);
        formData.append('min_brightness',  document.getElementById('minBrightness').value);
        formData.append('max_brightness',  document.getElementById('maxBrightness').value);
        formData.append('hash_threshold',  document.getElementById('hashThreshold').value);

        const res = await fetch('/api/photo-filter/analyze', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        sessionId = data.session_id;
        analysisResults = data.results;

        // 若上傳了目標人物但後端沒偵測到臉，給予提示
        if (targetFile && data.summary.target_face_detected === false) {
            alert('⚠️ 偵測提示：\n系統在「目標人物照片」中未偵測到明顯人臉(即使已嘗試自動增強處理)。\n\n這可能導致後續比對精確度下降或失敗。建議更換一張光線充足、臉部比例較大且正面的照片以達到最佳效果。');
        }

        renderSummary(data.summary);
        renderGrid(analysisResults, 'all');

        summaryBar.style.display = 'flex';
        downloadZipBtn.style.display = 'inline-block';
        reanalyzeBar.style.display = 'block';

    } catch (err) {
        alert('分析失敗: ' + err.message);
    } finally {
        clearInterval(timer);
        window.isProcessing = false;
        loadingBar.style.display = 'none';
        analyzeBtn.disabled = false;
    }
});

// ===== Render Summary =====
function renderSummary(s) {
    document.getElementById('cnt-all').textContent = s.total;
    document.getElementById('cnt-keep').textContent = s.keep;
    document.getElementById('cnt-blurry').textContent = s.blurry;
    document.getElementById('cnt-exposure').textContent = s.exposure;
    document.getElementById('cnt-duplicate').textContent = s.duplicate;
    if (s.target_match !== undefined && targetFile) {
        document.getElementById('chip-target').style.display = 'inline-block';
        document.getElementById('cnt-target').textContent = s.target_match;
    } else {
        document.getElementById('chip-target').style.display = 'none';
    }
}

// ===== Render Grid =====
function renderGrid(results, filter) {
    currentFilter = filter;

    // Update chip active state
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    document.getElementById(`chip-${filter}`)?.classList.add('active');

    let filtered = results;
    if (filter === 'target') {
        filtered = results.filter(r => r.is_target);
    } else if (filter !== 'all') {
        filtered = results.filter(r => r.status === filter);
    }
    
    resultsGrid.innerHTML = '';

    if (filtered.length === 0) {
        resultsGrid.innerHTML = '<p style="color:rgba(255,255,255,0.5); text-align:center; padding:2rem; grid-column:1/-1;">此分類沒有圖片</p>';
        downloadZipBtn.disabled = true;
        downloadZipBtn.textContent = '此分類無圖片';
        return;
    }

    // Update Download Button Label
    const filterNames = {
        all: '全部',
        target: '目標人物',
        keep: '保留',
        blurry: '模糊',
        exposure: '曝光',
        duplicate: '重複'
    };
    downloadZipBtn.disabled = false;
    downloadZipBtn.textContent = `⬇ 下載 [${filterNames[filter] || filter}] 圖片 (ZIP)`;

    filtered.forEach((item, i) => {
        const card = document.createElement('div');
        card.className = 'photo-card';
        card.style.animationDelay = `${i * 0.04}s`;

        const thumbUrl = sessionId
            ? `/api/photo-filter/thumbnail/${sessionId}/${encodeURIComponent(item.filename)}`
            : '';

        const badgeClass = {
            keep: 'badge-keep',
            blurry: 'badge-blurry',
            exposure: 'badge-exposure',
            duplicate: 'badge-duplicate',
            error: 'badge-error'
        }[item.status] || 'badge-error';

        const badgeLabel = {
            keep: '✓ 保留',
            blurry: '~ 模糊',
            exposure: '☀ 曝光問題',
            duplicate: '≈ 重複',
            error: '! 錯誤'
        }[item.status] || item.status;

        card.innerHTML = `
            <img class="card-thumb" src="${thumbUrl}" alt="${item.filename}" loading="lazy" onerror="this.style.display='none'">
            <div class="card-body">
                <div class="card-filename" title="${item.filename}">${item.filename}</div>
                <span class="card-badge ${badgeClass}">${badgeLabel}</span>
                <div class="card-stats">
                    <div class="stat-row"><span>清晰度</span><span>${item.blur_score}</span></div>
                    <div class="stat-row"><span>亮度</span><span>${item.brightness}</span></div>
                    <div class="stat-row"><span>對比度</span><span>${item.contrast}</span></div>
                    <div class="stat-row"><span>尺寸</span><span>${item.width}×${item.height}</span></div>
                    <div class="stat-row"><span>大小</span><span>${item.file_size_kb} KB</span></div>
                    ${item.dup_group ? `<div class="stat-row"><span>重複組</span><span style="color:#8b5cf6">${item.dup_group}</span></div>` : ''}
                </div>
                ${item.is_target ? '<span class="card-badge badge-target" style="margin-top:6px;">🎯 目標人物</span>' : (item.has_face ? '<div class="card-face-tag">👤 偵測到人臉</div>' : '')}
                ${item.reason ? `<div style="font-size:0.72rem; color:rgba(255,255,255,0.45); margin-top:6px;">${item.reason}</div>` : ''}
            </div>
        `;
        resultsGrid.appendChild(card);
    });
}

// ===== Filter Chips =====
document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
        renderGrid(analysisResults, chip.dataset.filter);
    });
});

// ===== Reanalyze (client-side re-classify) =====
document.getElementById('reanalyzeBtn').addEventListener('click', async () => {
    // 使用現有的 selectedFiles 再重新送出
    analyzeBtn.click();
});

// ===== Export CSV =====
exportBtn.addEventListener('click', async () => {
    if (!analysisResults.length) return;
    exportBtn.disabled = true;
    exportBtn.textContent = '正在匯出...';
    try {
        const res = await fetch('/api/photo-filter/export-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ results: analysisResults })
        });
        if (!res.ok) throw new Error('匯出失敗');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `photo_filter_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert(e.message);
    } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = '⬇ 匯出 CSV 報表';
    }
});

// ===== Download ZIP =====
downloadZipBtn.addEventListener('click', async () => {
    if (!sessionId || !analysisResults.length) return;

    // Get files for current filter
    let filtered = analysisResults;
    if (currentFilter === 'target') {
        filtered = analysisResults.filter(r => r.is_target);
    } else if (currentFilter !== 'all') {
        filtered = analysisResults.filter(r => r.status === currentFilter);
    }

    if (filtered.length === 0) return;

    const filenames = filtered.map(r => r.filename);
    const originalText = downloadZipBtn.textContent;
    
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = '🗜️ 正在打包中...';

    try {
        const res = await fetch('/api/photo-filter/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                filenames: filenames,
                filter_label: currentFilter
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || '打包失敗');
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const timestamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '_');
        a.download = `photos_${currentFilter}_${timestamp}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('下載失敗: ' + e.message);
    } finally {
        downloadZipBtn.disabled = false;
        downloadZipBtn.textContent = originalText;
    }
});
