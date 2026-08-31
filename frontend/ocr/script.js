document.addEventListener('DOMContentLoaded', () => {
    // === DOM 元素 ===
    const dropZone = document.getElementById('dropZone');
    const imageInput = document.getElementById('imageInput');
    const filePreviewGrid = document.getElementById('filePreviewGrid');
    const actionBar = document.getElementById('actionBar');
    const extractBtn = document.getElementById('extractBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const progressBar = document.getElementById('progressBar');
    const results = document.getElementById('results');
    const resultText = document.getElementById('resultText');
    const resultStats = document.getElementById('resultStats');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const sendBtn = document.getElementById('sendBtn');
    const tipsSection = document.getElementById('tipsSection');
    const apiKeyInput = document.getElementById('apiKey');
    const toggleApiBtn = document.getElementById('toggleApiBtn');
    const engineSelection = document.getElementById('engineSelection');
    const ocrEngineRadios = document.getElementsByName('ocrEngine');

    // API Key不再儲存於本地端以防內網發布遭盜用

    // API Key 顯示/隱藏切換
    toggleApiBtn.addEventListener('click', () => {
        const type = apiKeyInput.type === 'password' ? 'text' : 'password';
        apiKeyInput.type = type;
        toggleApiBtn.textContent = type === 'password' ? '👁️' : '🙈';
    });

    apiKeyInput.addEventListener('change', () => {
        updateEngineVisibility();
    });

    apiKeyInput.addEventListener('input', () => {
        updateEngineVisibility();
    });

    function updateEngineVisibility() {
        if (apiKeyInput.value.trim()) {
            engineSelection.style.opacity = '0.3';
            engineSelection.style.pointerEvents = 'none';
        } else {
            engineSelection.style.opacity = '1';
            engineSelection.style.pointerEvents = 'auto';
        }
    }
    
    // 初始化可見性
    updateEngineVisibility();

    let selectedFiles = [];
    let isProcessing = false;

    // === 防意外關閉 ===
    window.addEventListener('beforeunload', (e) => {
        if (isProcessing) {
            e.preventDefault();
            e.returnValue = '辨識正在進行中，確定要離開嗎？';
        }
    });

    // === 拖放事件 ===
    dropZone.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-btn')) return;
        imageInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });

    imageInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
        imageInput.value = ''; // 允許重複選同一檔案
    });

    // === 貼上事件 (Ctrl+V) ===
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                const blob = items[i].getAsFile();
                if (blob) {
                    // 建立一個具名檔案
                    const file = new File([blob], `pasted_image_${new Date().getTime()}.png`, { type: blob.type });
                    files.push(file);
                }
            }
        }
        
        if (files.length > 0) {
            showToast(`📋 已貼上 ${files.length} 張圖片`);
            handleFiles(files);
        }
    });

    // === 檔案處理 ===
    function handleFiles(files) {
        const validExts = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
        const validFiles = Array.from(files).filter(f => {
            const ext = '.' + f.name.split('.').pop().toLowerCase();
            return validExts.includes(ext);
        });

        if (validFiles.length === 0) {
            showToast('⚠️ 僅支援 JPG、PNG、WebP 或 PDF 格式');
            return;
        }

        selectedFiles = [...selectedFiles, ...validFiles];
        updatePreview();
        updateUI();
    }

    function updatePreview() {
        filePreviewGrid.innerHTML = '';
        
        selectedFiles.forEach((file, index) => {
            const card = document.createElement('div');
            card.className = 'file-preview-card';
            card.style.animationDelay = `${index * 0.05}s`;

            const isPdf = file.name.toLowerCase().endsWith('.pdf');
            
            if (isPdf) {
                // PDF 顯示圖示
                const pdfIcon = document.createElement('div');
                pdfIcon.className = 'pdf-preview-icon';
                pdfIcon.innerHTML = '📄<br>PDF';
                card.appendChild(pdfIcon);
            } else {
                // 圖片預覽
                const img = document.createElement('img');
                img.alt = file.name;
                const reader = new FileReader();
                reader.onload = (e) => { img.src = e.target.result; };
                reader.readAsDataURL(file);
                card.appendChild(img);
            }

            // 檔名標籤
            const nameLabel = document.createElement('div');
            nameLabel.className = 'file-name';
            nameLabel.textContent = file.name;

            // 移除按鈕
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '✕';
            removeBtn.title = '移除此檔案';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedFiles.splice(index, 1);
                updatePreview();
                updateUI();
            });

            card.appendChild(nameLabel);
            card.appendChild(removeBtn);
            filePreviewGrid.appendChild(card);
        });
    }

    function updateUI() {
        const hasFiles = selectedFiles.length > 0;
        actionBar.style.display = hasFiles ? 'flex' : 'none';
        extractBtn.disabled = !hasFiles;
    }

    // === 清除全部 ===
    clearBtn.addEventListener('click', () => {
        selectedFiles = [];
        filePreviewGrid.innerHTML = '';
        updateUI();
        results.style.display = 'none';
        showToast('🗑️ 已清除全部圖片');
    });

    // === 開始辨識 ===
    extractBtn.addEventListener('click', async () => {
        if (selectedFiles.length === 0) return;

        const apiKey = apiKeyInput.value.trim();
        const formData = new FormData();
        selectedFiles.forEach(f => formData.append('files', f));
        if (apiKey) {
            formData.append('api_key', apiKey);
        } else {
            // 獲取選定的本地引擎
            let selectedEngine = 'tesseract';
            for (const radio of ocrEngineRadios) {
                if (radio.checked) {
                    selectedEngine = radio.value;
                    break;
                }
            }
            formData.append('engine', selectedEngine);
        }

        // UI 狀態切換
        isProcessing = true;
        loading.style.display = 'block';
        const analyzeTimer = document.getElementById('analyzeTimer');
        if (analyzeTimer) {
            analyzeTimer.style.display = 'block';
            analyzeTimer.textContent = '已處理: 0.0 秒';
        }
        
        if (apiKey) {
            loadingText.textContent = '正在連線 Gemini 進行雲端高精準度辨識...';
        } else {
            const selectedEngine = Array.from(ocrEngineRadios).find(r => r.checked)?.value || 'tesseract';
            const engineName = selectedEngine === 'tesseract' ? 'RapidOCR' : 'EasyOCR';
            loadingText.textContent = `正在初始化本地 ${engineName} 引擎...`;
        }
        extractBtn.disabled = true;
        results.style.display = 'none';
        tipsSection.style.display = 'none';
        progressBar.style.width = '0%';

        const analysisStart = Date.now();
        const durationTimer = setInterval(() => {
            if (analyzeTimer) {
                const sec = ((Date.now() - analysisStart) / 1000).toFixed(1);
                analyzeTimer.textContent = `已處理: ${sec} 秒`;
            }
        }, 100);


        // 模擬進度條動畫
        let progress = 0;
        const progressTimer = setInterval(() => {
            if (progress < 90) {
                const step = apiKey ? 2 : 5; // 雲端較慢，進度走慢一點
                progress += Math.random() * step;
                progressBar.style.width = Math.min(progress, 90) + '%';
            }
            
            if (!apiKey) {
                const selectedEngine = Array.from(ocrEngineRadios).find(r => r.checked)?.value || 'tesseract';
                const engineName = selectedEngine === 'tesseract' ? 'RapidOCR' : 'EasyOCR';
                
                if (progress > 20 && progress < 40) loadingText.textContent = '正在預處理檔案 (灰階化、PDF 分頁)...';
                else if (progress > 40 && progress < 75) loadingText.textContent = `正在執行本地 ${engineName} 辨識，請稍候...`;
                else if (progress > 75) loadingText.textContent = '即將完成，正在整理結果...';
            } else {
                if (progress > 30 && progress < 80) loadingText.textContent = 'Gemini 正在深度分析文件內容中...';
                else if (progress > 80) loadingText.textContent = '雲端辨識即將完成...';
            }
        }, 800);

        try {
            const startTime = Date.now();
            const response = await fetch('/api/ocr', {
                method: 'POST',
                body: formData
            });

            clearInterval(progressTimer);
            progressBar.style.width = '100%';

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || `辨識失敗 (HTTP ${response.status})`);
            }

            const data = await response.json();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            // 顯示結果
            resultText.value = data.text;
            results.style.display = 'block';

            // 統計資訊
            const charCount = data.text.replace(/[\s\n\-—]/g, '').length;
            const lineCount = data.text.split('\n').filter(l => l.trim()).length;
            
            let methodTag = '🏠 本地引擎';
            if (data.method === 'cloud') {
                methodTag = '✨ Gemini 雲端';
            } else if (data.method.includes('tesseract') || data.method.includes('paddleocr') || data.method.includes('rapidocr')) {
                methodTag = '🚀 RapidOCR';
            } else if (data.method.includes('easyocr')) {
                methodTag = '🧠 EasyOCR';
            }
            
            resultStats.innerHTML = `
                <span>📊 共 ${charCount} 字</span>
                <span>📝 共 ${lineCount} 行</span>
                <span>⏱️ 耗時 ${elapsed} 秒</span>
                <span>📂 ${selectedFiles.length} 個檔案</span>
                <span style="color: var(--primary-light)">🛠️ ${methodTag}</span>
            `;

            // 滑動到結果區
            setTimeout(() => {
                results.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 200);

            showToast(`✅ 辨識完成！共提取 ${charCount} 字`);
            
        } catch (err) {
            clearInterval(progressTimer);
            if (typeof durationTimer !== 'undefined') clearInterval(durationTimer);
            
            let errorMsg = err.message;
            if (errorMsg.includes('Failed to fetch')) {
                errorMsg = '伺服器連線受阻或逾時。請確認系統工作機 (backend) 正在運行。';
            }
            showToast('❌ ' + errorMsg);
            console.error('OCR Error:', err);
        } finally {
            if (typeof durationTimer !== 'undefined') clearInterval(durationTimer);
            isProcessing = false;
            loading.style.display = 'none';
            extractBtn.disabled = false;
            tipsSection.style.display = 'block';
        }

    });

    // === 複製文字 ===
    copyBtn.addEventListener('click', async () => {
        const text = resultText.value;
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            copyBtn.innerHTML = '<span>✅</span> 已複製';
            showToast('📋 文字已複製到剪貼簿');
            setTimeout(() => {
                copyBtn.innerHTML = '<span>📋</span> 複製文字';
            }, 2000);
        } catch {
            // Fallback
            resultText.select();
            document.execCommand('copy');
            copyBtn.innerHTML = '<span>✅</span> 已複製';
            setTimeout(() => {
                copyBtn.innerHTML = '<span>📋</span> 複製文字';
            }, 2000);
        }
    });

    // === 下載文字檔 ===
    downloadBtn.addEventListener('click', () => {
        const text = resultText.value;
        if (!text) return;

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `OCR辨識結果_${new Date().toISOString().slice(0,10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('💾 文字檔已開始下載');
    });


    // === API Key 相關 ===
    sendBtn.addEventListener('click', () => {
        const text = resultText.value;
        if (!text) {
            showToast('⚠️ 沒有可送出的文字');
            return;
        }

        // 透過 localStorage 將文字傳遞給校對頁面
        localStorage.setItem('ocr_temp_text', text);
        window.location.href = '../proofreader/';
    });

    // === Toast 通知 ===
    function showToast(message) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 2800);
    }
});
