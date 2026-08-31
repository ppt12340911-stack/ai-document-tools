// ============================================
// Word 轉 PDF & PDF 權限解鎖 - 前端互動邏輯
// ============================================

// ===== Tabs Switching =====
const tabWordBtn = document.getElementById('tabWordBtn');
const tabUnlockBtn = document.getElementById('tabUnlockBtn');
const wordSection = document.getElementById('wordSection');
const unlockSection = document.getElementById('unlockSection');

const tabImageBtn = document.getElementById('tabImageBtn');
const imageSection = document.getElementById('imageSection');

tabWordBtn.addEventListener('click', () => {
    setActiveTab(tabWordBtn, wordSection);
});

tabUnlockBtn.addEventListener('click', () => {
    setActiveTab(tabUnlockBtn, unlockSection);
});

tabImageBtn.addEventListener('click', () => {
    setActiveTab(tabImageBtn, imageSection);
});

function setActiveTab(btn, section) {
    [tabWordBtn, tabUnlockBtn, tabImageBtn].forEach(b => b.classList.remove('active'));
    [wordSection, unlockSection, imageSection].forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    section.classList.add('active');
}

// ===== Word 轉 PDF DOM =====
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const convertBtn = document.getElementById('convertBtn');
const clearBtn = document.getElementById('clearBtn');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressCount = document.getElementById('progressCount');
const progressStatus = document.getElementById('progressStatus');
const resultsSection = document.getElementById('resultsSection');
const resultsList = document.getElementById('resultsList');
const downloadAllBtn = document.getElementById('downloadAllBtn');

let selectedFiles = [];
let currentConversionId = null;

// 防呆關閉視窗
window.isProcessing = false;
window.addEventListener('beforeunload', (e) => {
    if (window.isProcessing) {
        e.preventDefault();
        e.returnValue = '系統正在處理中，離開將會中斷任務，確定要離開嗎？';
    }
});

// ===== Drag & Drop =====
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

// ===== File Handling =====
function handleFiles(files) {
    const validExtensions = ['.docx', '.doc'];
    for (let file of files) {
        const ext = file.name.toLowerCase();
        if (validExtensions.some(e => ext.endsWith(e))) {
            // 避免重複添加
            if (!selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
                selectedFiles.push(file);
            }
        }
    }
    renderFileList();
    updateUI();
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.style.animationDelay = `${index * 0.05}s`;
        
        const ext = file.name.toLowerCase().endsWith('.doc') ? '📘' : '📗';
        
        item.innerHTML = `
            <div class="file-item-info">
                <span class="file-item-icon">${ext}</span>
                <span class="file-item-name" title="${file.name}">${file.name}</span>
            </div>
            <span class="file-item-size">${formatSize(file.size)}</span>
            <button class="file-remove-btn" onclick="removeFile(${index})" title="移除">✕</button>
        `;
        fileList.appendChild(item);
    });
}

window.removeFile = (index) => {
    selectedFiles.splice(index, 1);
    renderFileList();
    updateUI();
};

function updateUI() {
    const hasFiles = selectedFiles.length > 0;
    convertBtn.disabled = !hasFiles;
    clearBtn.style.display = hasFiles ? 'flex' : 'none';
}

// ===== Clear All =====
clearBtn.addEventListener('click', () => {
    selectedFiles = [];
    fileList.innerHTML = '';
    updateUI();
    resultsSection.style.display = 'none';
    progressSection.style.display = 'none';
});

// ===== Convert =====
convertBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;
    
    // UI: 顯示進度
    convertBtn.disabled = true;
    progressSection.style.display = 'block';
    resultsSection.style.display = 'none';
    progressBar.style.width = '0%';
    progressCount.textContent = `0/${selectedFiles.length}`;
    progressStatus.textContent = '正在上傳檔案...';

    window.isProcessing = true;
    let seconds = 0;
    let intervalText = '正在上傳檔案...';
    // 儲存狀態給計時器使用
    const timerInterval = setInterval(() => {
        seconds++;
        progressStatus.textContent = `${intervalText} (已耗時: ${seconds} 秒)`;
    }, 1000);

    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));

    try {
        const response = await fetch('/api/convert-to-pdf', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(err);
        }

        // 使用 SSE 串流讀取進度
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalData = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            
            // 解析 SSE 事件
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留未完成的行
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        if (data.type === 'progress') {
                            const pct = Math.round((data.completed / data.total) * 100);
                            progressBar.style.width = pct + '%';
                            progressCount.textContent = `${data.completed}/${data.total}`;
                            intervalText = `正在轉換: ${data.filename}`;
                        } else if (data.type === 'complete') {
                            finalData = data;
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        }
                    } catch (parseErr) {
                        // 忽略解析錯誤
                        if (parseErr.message && !parseErr.message.includes('JSON')) {
                            throw parseErr;
                        }
                    }
                }
            }
        }

        if (finalData) {
            // 完成
            progressBar.style.width = '100%';
            progressCount.textContent = `${finalData.results.length}/${selectedFiles.length}`;
            progressStatus.textContent = '轉換完成！';
            
            currentConversionId = finalData.conversion_id;
            renderResults(finalData.results);
        }

    } catch (error) {
        console.error(error);
        intervalText = `❌ 轉換失敗: ${error.message}`;
        progressStatus.textContent = intervalText;
    } finally {
        clearInterval(timerInterval);
        window.isProcessing = false;
        convertBtn.disabled = false;
        updateUI();
    }
});

// ===== Render Results =====
function renderResults(results) {
    resultsSection.style.display = 'block';
    resultsList.innerHTML = '';
    
    let successCount = 0;

    results.forEach((r, i) => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.style.animationDelay = `${i * 0.08}s`;
        
        const isSuccess = r.status === 'success';
        if (isSuccess) successCount++;

        item.innerHTML = `
            <div class="result-info">
                <span class="result-icon">${isSuccess ? '📕' : '⚠️'}</span>
                <div class="result-details">
                    <div class="result-name" title="${r.filename}">${r.filename}</div>
                    <div class="result-meta">${isSuccess ? r.original_name + ' → PDF' : r.error}</div>
                </div>
            </div>
            <div class="result-status">
                <span class="status-badge ${isSuccess ? 'status-success' : 'status-error'}">
                    ${isSuccess ? '成功' : '失敗'}
                </span>
                ${isSuccess ? `<button class="btn-download-single" onclick="downloadSingle('${r.id}', '${r.filename}')">⬇ 下載</button>` : ''}
            </div>
        `;
        resultsList.appendChild(item);
    });

    // 如果沒有成功的檔案，隱藏一鍵下載按鈕
    downloadAllBtn.style.display = successCount > 0 ? 'flex' : 'none';
    
    // 滾動到結果區
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// ===== Download Single =====
window.downloadSingle = async (fileId, filename) => {
    try {
        const response = await fetch(`/api/download-pdf/${currentConversionId}/${fileId}`);
        if (!response.ok) throw new Error('下載失敗');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (e) {
        alert('下載失敗: ' + e.message);
    }
};

// ===== Download All (ZIP) =====
downloadAllBtn.addEventListener('click', async () => {
    if (!currentConversionId) return;
    
    downloadAllBtn.disabled = true;
    downloadAllBtn.innerHTML = '<span class="btn-icon">⏳</span> 打包中...';
    
    try {
        const response = await fetch(`/api/download-all-pdfs/${currentConversionId}`);
        if (!response.ok) throw new Error('下載失敗');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `轉換結果_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (e) {
        alert('下載失敗: ' + e.message);
    } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = '<span class="btn-icon">📦</span> 一鍵下載全部 (ZIP)';
    }
});

// ============================================
// PDF 解鎖功能
// ============================================
const unlockDropZone = document.getElementById('unlockDropZone');
const unlockFileInput = document.getElementById('unlockFileInput');
const unlockFileList = document.getElementById('unlockFileList');
const unlockBtn = document.getElementById('unlockBtn');
const unlockProgressSection = document.getElementById('unlockProgressSection');
const unlockProgressStatus = document.getElementById('unlockProgressStatus');

let unlockSelectedFiles = [];

// Drag & Drop
unlockDropZone.addEventListener('click', () => unlockFileInput.click());
unlockDropZone.addEventListener('dragover', (e) => { e.preventDefault(); unlockDropZone.classList.add('dragover'); });
unlockDropZone.addEventListener('dragleave', () => unlockDropZone.classList.remove('dragover'));
unlockDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    unlockDropZone.classList.remove('dragover');
    handleUnlockFiles(e.dataTransfer.files);
});
unlockFileInput.addEventListener('change', (e) => handleUnlockFiles(e.target.files));

function handleUnlockFiles(files) {
    if (!files || files.length === 0) return;
    
    for (let file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;
        // 避免重複
        if (!unlockSelectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            unlockSelectedFiles.push(file);
        }
    }
    
    renderUnlockFileList();
    unlockBtn.disabled = unlockSelectedFiles.length === 0;
    unlockProgressSection.style.display = 'none';
}

function renderUnlockFileList() {
    unlockFileList.innerHTML = '';
    unlockSelectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <div class="file-item-info">
                <span class="file-item-icon">🔓</span>
                <span class="file-item-name" title="${file.name}">${file.name}</span>
            </div>
            <span class="file-item-size">${formatSize(file.size)}</span>
            <button class="file-remove-btn" onclick="removeUnlockFile(${index})" title="移除">✕</button>
        `;
        unlockFileList.appendChild(item);
    });
}

window.removeUnlockFile = (index) => {
    unlockSelectedFiles.splice(index, 1);
    renderUnlockFileList();
    unlockBtn.disabled = unlockSelectedFiles.length === 0;
};

// 執行解鎖
unlockBtn.addEventListener('click', async () => {
    if (unlockSelectedFiles.length === 0) return;

    unlockBtn.disabled = true;
    unlockProgressSection.style.display = 'block';
    unlockProgressStatus.style.color = '#00cec9';
    unlockProgressStatus.textContent = `正在準備批次解鎖 ${unlockSelectedFiles.length} 個檔案...`;

    const formData = new FormData();
    unlockSelectedFiles.forEach(file => formData.append('files', file));

    try {
        // 使用帶斜線的路徑作為冗餘選項，避免 405
        const response = await fetch('/api/pdf/unlock/', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.detail || '解鎖失敗，伺服器婉拒此請求 (Method Not Allowed 或 密碼錯誤)。');
        }

        const contentType = response.headers.get('Content-Type');
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // 根據回傳格式決定副檔名
        const isZip = contentType && contentType.includes('zip');
        a.download = isZip ? `Batch_Unlocked_${new Date().getTime()}.zip` : `Unlocked_${unlockSelectedFiles[0].name}`;
        
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        unlockProgressStatus.style.color = '#00e676';
        unlockProgressStatus.textContent = `✅ 成功處理 ${unlockSelectedFiles.length} 個檔案！${isZip ? '已下載 ZIP 壓縮檔。' : '已下載 PDF 檔案。'}`;

    } catch (e) {
        unlockProgressStatus.style.color = '#ff5252';
        unlockProgressStatus.textContent = `❌ ${e.message}`;
    } finally {
        unlockBtn.disabled = false;
    }
});

// ============================================
// PDF 轉圖片功能
// ============================================
const imageDropZone = document.getElementById('imageDropZone');
const imageFileInput = document.getElementById('imageFileInput');
const imageFileList = document.getElementById('imageFileList');
const imageConvertBtn = document.getElementById('imageConvertBtn');
const imageOptions = document.getElementById('imageOptions');
const imageFormat = document.getElementById('imageFormat');
const imageDpi = document.getElementById('imageDpi');
const imageProgressSection = document.getElementById('imageProgressSection');
const imageProgressStatus = document.getElementById('imageProgressStatus');

let imageSelectedFile = null;

// Drag & Drop
imageDropZone.addEventListener('click', () => imageFileInput.click());
imageDropZone.addEventListener('dragover', (e) => { e.preventDefault(); imageDropZone.classList.add('dragover'); });
imageDropZone.addEventListener('dragleave', () => imageDropZone.classList.remove('dragover'));
imageDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    imageDropZone.classList.remove('dragover');
    handleImageFiles(e.dataTransfer.files);
});
imageFileInput.addEventListener('change', (e) => handleImageFiles(e.target.files));

function handleImageFiles(files) {
    if (!files || files.length === 0) return;
    
    // 只取第一個檔案 (PDF 轉圖片通常一個一個轉)
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        alert('請選擇 PDF 檔案');
        return;
    }
    
    imageSelectedFile = file;
    renderImageFileList();
    
    imageConvertBtn.disabled = false;
    imageOptions.style.display = 'flex';
    imageProgressSection.style.display = 'none';
}

function renderImageFileList() {
    imageFileList.innerHTML = '';
    if (!imageSelectedFile) return;

    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
        <div class="file-item-info">
            <span class="file-item-icon">🖼️</span>
            <span class="file-item-name" title="${imageSelectedFile.name}">${imageSelectedFile.name}</span>
        </div>
        <span class="file-item-size">${formatSize(imageSelectedFile.size)}</span>
        <button class="file-remove-btn" onclick="removeImageFile()" title="移除">✕</button>
    `;
    imageFileList.appendChild(item);
}

window.removeImageFile = () => {
    imageSelectedFile = null;
    renderImageFileList();
    imageConvertBtn.disabled = true;
    imageOptions.style.display = 'none';
};

// 執行轉換
imageConvertBtn.addEventListener('click', async () => {
    if (!imageSelectedFile) return;

    imageConvertBtn.disabled = true;
    imageProgressSection.style.display = 'block';
    imageProgressStatus.style.color = '#f093fb';
    imageProgressStatus.textContent = '正在進行高品質渲染與轉換，請稍候...';

    const formData = new FormData();
    formData.append('file', imageSelectedFile);
    formData.append('format', imageFormat.value);
    formData.append('dpi', imageDpi.value);

    try {
        const response = await fetch('/api/pdf/to-image', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.detail || '轉換失敗，請檢查檔案是否損毀或過大。');
        }

        const contentType = response.headers.get('Content-Type');
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = `Converted_${imageSelectedFile.name.replace('.pdf', '')}`;
        
        // 嘗試從 Header 抓檔名
        if (contentDisposition) {
            const match = contentDisposition.match(/filename=(.+)/);
            if (match) filename = match[1];
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        imageProgressStatus.style.color = '#00e676';
        imageProgressStatus.textContent = `✅ 轉換成功！檔案已下載。`;

    } catch (e) {
        imageProgressStatus.style.color = '#ff5252';
        imageProgressStatus.textContent = `❌ ${e.message}`;
    } finally {
        imageConvertBtn.disabled = false;
    }
});
