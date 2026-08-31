const dropZoneDocs = document.getElementById('dropZoneDocs');
const docsInput = document.getElementById('docsInput');
const docsList = document.getElementById('docsList');

const dropZoneAudio = document.getElementById('dropZoneAudio');
const audioInput = document.getElementById('audioInput');
const browseAudioBtn = document.getElementById('browseAudioBtn');
const audioList = document.getElementById('audioList');
const youtubeUrlInput = document.getElementById('youtubeUrl');

const apiKeyInput = document.getElementById('apiKey');
const toggleApiBtn = document.getElementById('toggleApiBtn');
const analyzeBtn = document.getElementById('analyzeBtn');

const loading = document.getElementById('loading');
const resultsSection = document.getElementById('results');
const resultTextarea = document.getElementById('resultText');
const copyBtn = document.getElementById('copyBtn');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');

let selectedDocs = [];
let selectedAudio = null;

// 防呆關閉視窗
window.isProcessing = false;
window.addEventListener('beforeunload', (e) => {
    if (window.isProcessing) {
        e.preventDefault();
        e.returnValue = '系統正在處理中，離開將會中斷任務，確定要離開嗎？';
    }
});

// API Key 顯示切換
toggleApiBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleApiBtn.textContent = '🙈';
    } else {
        apiKeyInput.type = 'password';
        toggleApiBtn.textContent = '👁️';
    }
});

// 手寫稿上傳 (多選)
dropZoneDocs.addEventListener('click', () => docsInput.click());
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZoneDocs.addEventListener(eventName, e => {
        e.preventDefault();
        e.stopPropagation();
    });
});
let docsDragCount = 0;
dropZoneDocs.addEventListener('dragenter', () => {
    docsDragCount++;
    if(docsDragCount === 1) dropZoneDocs.style.borderColor = '#00e676';
});
dropZoneDocs.addEventListener('dragleave', () => {
    docsDragCount--;
    if(docsDragCount === 0) dropZoneDocs.style.borderColor = '';
});
dropZoneDocs.addEventListener('drop', (e) => { 
    docsDragCount = 0; 
    dropZoneDocs.style.borderColor = ''; 
    handleDocs(e.dataTransfer.files); 
});
docsInput.addEventListener('change', (e) => {
    handleDocs(e.target.files);
});

// === 貼上截圖 (Ctrl+V) ===
document.addEventListener('paste', (e) => {
    const items = e.clipboardData.items;
    const files = [];
    
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
                const file = new File([blob], `pasted_transcript_${new Date().getTime()}.png`, { type: blob.type });
                files.push(file);
            }
        }
    }
    
    if (files.length > 0) {
        // 假設 showToast 存在於全域或 UI 框架中
        if (typeof showToast === 'function') showToast(`📋 已貼上 ${files.length} 張手寫稿截圖`);
        handleDocs(files);
    }
});

function handleDocs(files) {
    for (let f of files) {
        if (!selectedDocs.some(old => old.name === f.name)) {
            selectedDocs.push(f);
        }
    }
    renderDocs();
    updateUI();
}

function renderDocs() {
    docsList.innerHTML = '';
    selectedDocs.forEach((f, i) => {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.innerHTML = `<span>📄 ${f.name}</span> <button style="background:none; border:none; color:red; cursor:pointer;" onclick="event.stopPropagation(); removeDoc(${i})">✕</button>`;
        docsList.appendChild(div);
    });
}
window.removeDoc = (i) => { selectedDocs.splice(i, 1); renderDocs(); updateUI(); }

// 音檔上傳 (單選)
browseAudioBtn.addEventListener('click', (e) => { e.stopPropagation(); audioInput.click(); }); // 點擊按鈕開啟
dropZoneAudio.addEventListener('click', (e) => { 
    if(e.target.id !== 'youtubeUrl') audioInput.click(); // 避免點擊輸入框時開啟檔案
});
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZoneAudio.addEventListener(eventName, e => {
        e.preventDefault();
        e.stopPropagation();
    });
});
let audioDragCount = 0;
dropZoneAudio.addEventListener('dragenter', () => {
    audioDragCount++;
    if(audioDragCount === 1) dropZoneAudio.style.borderColor = '#b026ff';
});
dropZoneAudio.addEventListener('dragleave', () => {
    audioDragCount--;
    if(audioDragCount === 0) dropZoneAudio.style.borderColor = '';
});
dropZoneAudio.addEventListener('drop', (e) => { 
    audioDragCount = 0;
    dropZoneAudio.style.borderColor = '';
    if(e.dataTransfer.files.length > 0) {
        selectedAudio = e.dataTransfer.files[0];
        renderAudio();
        youtubeUrlInput.value = '';
    }
});

audioInput.addEventListener('change', (e) => {
    if(e.target.files.length > 0) {
        selectedAudio = e.target.files[0];
        renderAudio();
        // 清空 YT 網址
        youtubeUrlInput.value = '';
    }
});
youtubeUrlInput.addEventListener('input', () => {
    if(youtubeUrlInput.value.trim() !== '') {
        selectedAudio = null;
        renderAudio();
    }
});

function renderAudio() {
    audioList.innerHTML = '';
    if(selectedAudio) {
        audioList.innerHTML = `<div class="file-item"><span>🎵 ${selectedAudio.name}</span> <button style="background:none; border:none; color:red; cursor:pointer;" onclick="removeAudio()">✕</button></div>`;
    }
}
window.removeAudio = () => { selectedAudio = null; audioInput.value = ''; renderAudio(); }

function updateUI() {
    // 必須有 API key 加上 手寫稿
    analyzeBtn.disabled = !(apiKeyInput.value.trim() && selectedDocs.length > 0);
}

apiKeyInput.addEventListener('input', updateUI);

// 分析按鈕
analyzeBtn.addEventListener('click', async () => {
    updateUI();
    if(analyzeBtn.disabled) return;

    const apiKey = apiKeyInput.value.trim();
    const ytUrl = youtubeUrlInput.value.trim();

    analyzeBtn.disabled = true;
    loading.style.display = 'block';
    resultsSection.style.display = 'none';

    window.isProcessing = true;
    let seconds = 0;
    const originalText = '正在上傳並進行 AI 深度分析中，大型音頻或 YouTube 可能需花費數分鐘...';
    const loadingText = document.getElementById('loadingText');
    loadingText.textContent = originalText;
    const timerInterval = setInterval(() => {
        seconds++;
        loadingText.textContent = `${originalText} (已耗時: ${seconds} 秒)`;
    }, 1000);

    const formData = new FormData();
    formData.append('api_key', apiKey);
    formData.append('youtube_url', ytUrl);
    selectedDocs.forEach(f => formData.append('images', f));
    if (selectedAudio) formData.append('audio', selectedAudio);

    try {
        const res = await fetch('/api/transcript', { method: 'POST', body: formData });
        const data = await res.json();
        
        if(!res.ok) throw new Error(data.detail || '分析發生未知的錯誤');
        
        resultTextarea.value = data.result_text || '';
        resultsSection.style.display = 'block';
        resultsSection.scrollIntoView({ behavior: 'smooth' });
        
    } catch (err) {
        alert("分析失敗: " + err.message);
    } finally {
        clearInterval(timerInterval);
        window.isProcessing = false;
        loading.style.display = 'none';
        updateUI();
    }
});

// 工具按鈕
copyBtn.addEventListener('click', () => {
    resultTextarea.select();
    document.execCommand('copy');
    const old = copyBtn.innerText;
    copyBtn.innerText = '✅ 已複製';
    setTimeout(() => copyBtn.innerText = old, 2000);
});

downloadTxtBtn.addEventListener('click', () => {
    const text = resultTextarea.value;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `手寫逐字稿_${new Date().getTime()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
});
