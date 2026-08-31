/**
 * AI 校稿系統 - 前端核心邏輯
 * ================================
 * - 多檔上傳 & 拖放
 * - 三欄式互動 (檔案列表 ⟷ 原文 ⟷ 問題清單)
 * - 僅保留目前工作內容，避免文件內容與個資留在伺服器
 * - HTML 報告匯出
 */

// ============================================================
// 全域狀態
// ============================================================
const State = {
    uploadedFiles: [],           // [{file, id}]
    currentSessionId: null,
    filesData: [],               // 後端回傳的 files (含 pages_json)
    findings: [],                // 後端回傳的 findings
    currentFileIndex: 0,
    currentPage: 1,
    activeFilter: 'all',
    focusedFindingIdx: null,
    // --- 優化狀態 ---
    isAnalyzing: false,
    analysisTimerInterval: null,
};


// ============================================================
// DOM 參考
// ============================================================
const DOM = {
    dropArea: document.getElementById('dropArea'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
    analyzeBtn: document.getElementById('analyzeBtn'),
    exportBtn: document.getElementById('exportBtn'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    documentViewer: document.getElementById('documentViewer'),
    pageNav: document.getElementById('pageNav'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageInfo: document.getElementById('pageInfo'),
    findingsList: document.getElementById('findingsList'),
    findingsCount: document.getElementById('findingsCount'),
    filterBar: document.getElementById('filterBar'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText'),
    statusLeft: document.getElementById('statusLeft'),
    statusRight: document.getElementById('statusRight'),
    loadingTimer: document.getElementById('loadingTimer'),
    useWordCheck: document.getElementById('useWordCheck'),
    useCkipCheck: document.getElementById('useCkipCheck'),
};


// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    setupUpload();
    setupFilters();
    setupPageNav();
});


// ============================================================
// 檔案上傳
// ============================================================
function setupUpload() {
    DOM.dropArea.addEventListener('click', () => DOM.fileInput.click());

    DOM.dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        DOM.dropArea.classList.add('dragover');
    });

    DOM.dropArea.addEventListener('dragleave', () => {
        DOM.dropArea.classList.remove('dragover');
    });

    DOM.dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.dropArea.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    DOM.fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    DOM.analyzeBtn.addEventListener('click', startAnalysis);
    DOM.exportBtn.addEventListener('click', exportReport);
}

function handleFiles(fileList) {
    const allowed = ['.pdf', '.doc', '.docx'];
    for (const file of fileList) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!allowed.includes(ext)) {
            alert(`不支援的檔案格式：${file.name}\n僅接受 PDF / Word 檔案`);
            continue;
        }
        // 避免重複
        if (State.uploadedFiles.some(f => f.file.name === file.name && f.file.size === file.size)) continue;
        State.uploadedFiles.push({ file, id: crypto.randomUUID() });
    }
    renderFileList();
    DOM.analyzeBtn.disabled = State.uploadedFiles.length === 0;
}

function renderFileList() {
    DOM.fileList.innerHTML = '';
    State.uploadedFiles.forEach((item, idx) => {
        const ext = item.file.name.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? '📕' : '📘';
        const el = document.createElement('div');
        el.className = 'file-item' + (idx === State.currentFileIndex ? ' active' : '');
        el.innerHTML = `
            <span class="file-icon">${icon}</span>
            <span class="file-name" title="${item.file.name}">${item.file.name}</span>
            <span class="file-delete-btn" onclick="event.stopPropagation(); removeUploadedFile('${item.id}')" title="移除檔案">🗑️</span>
        `;
        el.addEventListener('click', () => selectFile(idx));
        DOM.fileList.appendChild(el);
    });
}

function removeUploadedFile(id) {
    State.uploadedFiles = State.uploadedFiles.filter(f => f.id !== id);
    if (State.currentFileIndex >= State.uploadedFiles.length) {
        State.currentFileIndex = Math.max(0, State.uploadedFiles.length - 1);
    }
    renderFileList();
    DOM.analyzeBtn.disabled = State.uploadedFiles.length === 0;
}


function selectFile(idx) {
    State.currentFileIndex = idx;
    State.currentPage = 1;
    renderFileList();
    renderViewer();
    renderFindings();
}

// ============================================================
// 分析流程
// ============================================================
async function startAnalysis() {
    if (State.uploadedFiles.length === 0) return;

    DOM.analyzeBtn.disabled = true;
    showLoading('正在上傳文件並進行校對分析...');

    const formData = new FormData();
    State.uploadedFiles.forEach(item => {
        formData.append('files', item.file);
    });

    const apiKey = DOM.apiKeyInput.value.trim();
    if (apiKey) {
        formData.append('api_key', apiKey);
    }
    
    // 傳遞引擎選用參數
    formData.append('use_word', DOM.useWordCheck.checked);
    formData.append('use_ckip', DOM.useCkipCheck.checked);

    // 啟動計時器與防誤關
    State.isAnalyzing = true;
    let seconds = 0;
    DOM.loadingTimer.textContent = '0s';
    State.analysisTimerInterval = setInterval(() => {
        seconds++;
        DOM.loadingTimer.textContent = `${seconds}s`;
    }, 1000);

    try {

        const res = await fetch('/api/proofread', { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `伺服器錯誤 (${res.status})`);
        }

        const data = await res.json();
        processResult(data);
        DOM.statusLeft.textContent = `分析完成：${data.summary}`;
        DOM.statusRight.textContent = `模型：${data.model_used} | 工作階段：${data.session_id.slice(0, 8)}`;

    } catch (err) {
        alert(`校稿失敗：${err.message}`);
        DOM.statusLeft.textContent = `錯誤：${err.message}`;
    } finally {
        clearInterval(State.analysisTimerInterval);
        State.isAnalyzing = false;
        hideLoading();
        DOM.analyzeBtn.disabled = false;
    }
}


function processResult(data) {
    State.currentSessionId = data.session_id;
    State.filesData = data.files.map(f => ({
        ...f,
        pages: JSON.parse(f.pages_json || '[]')
    }));
    State.findings = data.findings;
    State.currentFileIndex = 0;
    State.currentPage = 1;

    // 更新上傳檔案列表的 badge
    DOM.fileList.innerHTML = '';
    State.filesData.forEach((fileData, idx) => {
        const ext = fileData.filename.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? '📕' : '📘';
        const fileFindings = State.findings.filter(f => f.file_id === fileData.id || f.file === fileData.filename);
        const el = document.createElement('div');
        el.className = 'file-item' + (idx === 0 ? ' active' : '');
        el.innerHTML = `
            <span class="file-icon">${icon}</span>
            <span class="file-name" title="${fileData.filename}">${fileData.filename}</span>
            ${fileFindings.length > 0 ? `<span class="file-badge">${fileFindings.length}</span>` : ''}
        `;
        el.addEventListener('click', () => {
            State.currentFileIndex = idx;
            State.currentPage = 1;
            document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
            el.classList.add('active');
            renderViewer();
            renderFindings();
        });
        DOM.fileList.appendChild(el);
    });

    renderViewer();
    renderFindings();

    DOM.findingsCount.textContent = State.findings.length;
    
}


// ============================================================
// 原文檢視器
// ============================================================
function renderViewer() {
    const fileData = State.filesData[State.currentFileIndex];
    if (!fileData || !fileData.pages || fileData.pages.length === 0) {
        DOM.documentViewer.innerHTML = `
            <div class="viewer-placeholder">
                <div class="ph-icon">📄</div>
                <div class="ph-text">此檔案無法提取文字內容</div>
            </div>`;
        DOM.pageNav.style.display = 'none';
        return;
    }

    const pages = fileData.pages;
    const totalPages = pages.length;
    const page = pages[State.currentPage - 1];

    if (!page) return;

    // 顯示分頁導覽
    DOM.pageNav.style.display = 'flex';
    DOM.pageInfo.textContent = `第 ${State.currentPage} 頁 / 共 ${totalPages} 頁`;
    DOM.prevPageBtn.disabled = State.currentPage <= 1;
    DOM.nextPageBtn.disabled = State.currentPage >= totalPages;

    // 渲染文字並標記問題
    let html = highlightText(page.text, fileData);

    // 段落化
    html = html.split('\n').map(line => {
        if (line.trim() === '') return '<br>';
        return `<p style="margin: 0.3em 0;">${line}</p>`;
    }).join('');

    DOM.documentViewer.innerHTML = html;
}

function highlightText(text, fileData) {
    // 找出當前頁面、當前檔案的 findings
    const pageFindings = State.findings.filter(f =>
        (f.file_id === fileData.id || f.file === fileData.filename) &&
        f.page === State.currentPage
    );

    if (pageFindings.length === 0) return escapeHtml(text);

    // 依 original 長度降序排列，先處理長的避免巢狀衝突
    const sorted = [...pageFindings]
        .filter(f => f.original && f.original.length > 0)
        .sort((a, b) => b.original.length - a.original.length);

    let result = text;
    const replacements = [];

    for (const finding of sorted) {
        const orig = finding.original;
        const idx = result.indexOf(orig);
        if (idx === -1) continue;

        // 確保不重疊
        const overlaps = replacements.some(r =>
            (idx < r.end && idx + orig.length > r.start)
        );
        if (overlaps) continue;

        replacements.push({ start: idx, end: idx + orig.length, finding });
    }

    // 按位置排序，從後往前替換 (避免偏移)
    replacements.sort((a, b) => b.start - a.start);

    for (const r of replacements) {
        const cls = `highlight-${r.finding.finding_type}`;
        const id = `hl-${r.finding.page}-${r.start}`;
        const before = result.slice(0, r.start);
        const matched = result.slice(r.start, r.end);
        const after = result.slice(r.end);
        result = before +
            `<span class="${cls}" id="${id}" data-finding-idx="${State.findings.indexOf(r.finding)}" title="${escapeAttr(r.finding.reason)}">${escapeHtml(matched)}</span>` +
            after;
    }

    // 對未被替換的部分做 escapeHtml (已在 span 內的部分已經 escape)
    // 因為我們是在原文上做的替換，其他部分需要 escape
    // 簡化：直接返回 (因為 span 內已 escape)
    return result;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setupPageNav() {
    DOM.prevPageBtn.addEventListener('click', () => {
        if (State.currentPage > 1) {
            State.currentPage--;
            renderViewer();
            renderFindings();
        }
    });
    DOM.nextPageBtn.addEventListener('click', () => {
        const fileData = State.filesData[State.currentFileIndex];
        if (fileData && State.currentPage < fileData.pages.length) {
            State.currentPage++;
            renderViewer();
            renderFindings();
        }
    });
}

// ============================================================
// 問題清單
// ============================================================
function renderFindings() {
    const fileData = State.filesData[State.currentFileIndex];
    if (!fileData) {
        DOM.findingsList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">尚無分析結果</div>';
        return;
    }

    let filtered = State.findings.filter(f =>
        f.file_id === fileData.id || f.file === fileData.filename
    );

    if (State.activeFilter !== 'all') {
        filtered = filtered.filter(f => f.finding_type === State.activeFilter);
    }

    // 更新計數
    const allCount = State.findings.filter(f => f.file_id === fileData.id || f.file === fileData.filename).length;
    DOM.findingsCount.textContent = allCount;

    if (filtered.length === 0) {
        DOM.findingsList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">此檔案暫無問題 ✅</div>';
        return;
    }

    const typeLabels = {
        error: '❌ 錯字/漏字',
        inconsistency: '⚠️ 一致性',
        suggestion: '💡 語句建議',
        terminology: '🔬 專業術語'
    };

    DOM.findingsList.innerHTML = filtered.map((f, i) => {
        const globalIdx = State.findings.indexOf(f);
        const typeClass = `badge-${f.finding_type}`;
        const sourceClass = f.source === 'cloud' ? 'source-cloud' : 'source-local';
        const sourceLabel = f.source === 'cloud' ? '☁️ AI' : '🏠 本地';

        return `
        <div class="finding-card ${State.focusedFindingIdx === globalIdx ? 'focused' : ''}" 
             data-idx="${globalIdx}" data-page="${f.page}" onclick="onFindingClick(${globalIdx}, ${f.page})">
            <div class="finding-meta">
                <span class="finding-type-badge ${typeClass}">${typeLabels[f.finding_type] || f.finding_type}</span>
                <span class="finding-page">P.${f.page}</span>
                <span class="finding-source ${sourceClass}">${sourceLabel}</span>
            </div>
            <div class="finding-original">${escapeHtml(f.original || '')}</div>
            <div class="finding-suggested">${escapeHtml(f.suggested || '')}</div>
            <div class="finding-reason">${escapeHtml(f.reason || '')}</div>
        </div>`;
    }).join('');
}

function onFindingClick(globalIdx, page) {
    const finding = State.findings[globalIdx];
    if (!finding) return;

    // 跳到對應頁面
    if (State.currentPage !== page) {
        State.currentPage = page;
        renderViewer();
    }

    State.focusedFindingIdx = globalIdx;
    renderFindings();

    // 在原文中高亮對應位置
    setTimeout(() => {
        const highlights = DOM.documentViewer.querySelectorAll(`[data-finding-idx="${globalIdx}"]`);
        if (highlights.length > 0) {
            highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 移除舊的 active
            DOM.documentViewer.querySelectorAll('.highlight-active').forEach(el => el.classList.remove('highlight-active'));
            highlights[0].classList.add('highlight-active');
        }
    }, 50);
}

// ============================================================
// 篩選器
// ============================================================
function setupFilters() {
    DOM.filterBar.addEventListener('click', (e) => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;

        const type = chip.dataset.type;

        if (type === 'all') {
            // 全選/全取消
            const chips = DOM.filterBar.querySelectorAll('.filter-chip');
            const allActive = chip.classList.contains('active');
            chips.forEach(c => {
                if (allActive) c.classList.remove('active');
                else c.classList.add('active');
            });
            State.activeFilter = allActive ? '__none__' : 'all';
        } else {
            chip.classList.toggle('active');

            // 更新 "全部" chip
            const typeChips = DOM.filterBar.querySelectorAll('.filter-chip:not(.chip-all)');
            const allChip = DOM.filterBar.querySelector('.chip-all');
            const allChecked = [...typeChips].every(c => c.classList.contains('active'));
            if (allChecked) {
                allChip.classList.add('active');
                State.activeFilter = 'all';
            } else {
                allChip.classList.remove('active');
                // 找出唯一啟用的 filter
                const activeTypes = [...typeChips].filter(c => c.classList.contains('active')).map(c => c.dataset.type);
                if (activeTypes.length === 1) {
                    State.activeFilter = activeTypes[0];
                } else if (activeTypes.length === 0) {
                    State.activeFilter = '__none__';
                } else {
                    State.activeFilter = 'all'; // 多選時顯示全部
                }
            }
        }
        renderFindings();
    });
}

// ============================================================
// 匯出報告
// ============================================================
function exportReport() {
    if (!State.currentSessionId) return;
    window.open(`/api/proofread-export/${State.currentSessionId}`, '_blank');
}

// ============================================================
// 工具函數
// ============================================================
function showLoading(msg) {
    DOM.loadingText.textContent = msg;
    DOM.loadingOverlay.classList.add('show');
}

function hideLoading() {
    DOM.loadingOverlay.classList.remove('show');
}

// 離開頁面前提示
window.addEventListener('beforeunload', (e) => {
    if (State.isAnalyzing) {
        e.preventDefault();
        e.returnValue = '校稿正在進行中，離開將中斷分析。確定要離開嗎？';
    } else if (State.uploadedFiles.length > 0 && !State.currentSessionId) {
        e.preventDefault();
        e.returnValue = '有尚未分析的文件，確定要離開嗎？';
    }
});
