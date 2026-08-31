/* script.js - 風花圖分析工具 (v2) */
'use strict';

// ============================================================
// 狀態
// ============================================================
const state = {
    csvText: '',
    csvInfo: null,
    freqResult: null,
    concResult: null,
    currentProjectId: null,
    freqColorscale: 'Plasma',
    concColorscale: 'Turbo',
    nDirs: 16,
    speedBins: [0, 1, 3, 5, 7, 10],
};

// ============================================================
// DOM 快取
// ============================================================
const $id = (id) => document.getElementById(id);
const dropZone      = $id('dropZone');
const csvInput      = $id('csvInput');
const mappingSection = $id('mappingSection');
const dirColSel     = $id('dirColSel');
const speedColSel   = $id('speedColSel');
const concColSel    = $id('concColSel');
const nDirsSel      = $id('nDirsSel');
const nDirsTopSel   = $id('nDirsTopSel');
const computeBtn    = $id('computeBtn');
const chartPlaceholder = $id('chartPlaceholder');
const dualChart     = $id('dualChart');
const statsBar      = $id('statsBar');
const dataInfo      = $id('dataInfo');
const speedBinsInput = $id('speedBinsInput');
const freqColorscaleSel = $id('freqColorscaleSel');
const concColorscaleSel = $id('concColorscaleSel');
const markerSizeMultiplierInput = $id('markerSizeMultiplier');

const exportPngBtn  = $id('exportPngBtn');
const applySettingsBtn = $id('applySettingsBtn');
const freqTitleInput = $id('freqTitleInput');
const concTitleInput = $id('concTitleInput');
const projectNameInput = $id('projectNameInput');
const dataPreview   = $id('dataPreview');
const newProjectBtn = $id('newProjectBtn');
const confirmSaveBtn = $id('confirmSaveBtn');
const saveProjectBtn = $id('saveProjectBtn');
const projectList = $id('projectList');

// ============================================================
// Toast
// ============================================================
function showToast(msg, type = '') {
    const c = $id('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, 3000);
}

// ============================================================
// CSV 上傳
// ============================================================
dropZone.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    csvInput.click();
});
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleCsvFile(f);
});
csvInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleCsvFile(e.target.files[0]);
    csvInput.value = '';
});

async function handleCsvFile(file) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
        showToast('請上傳 CSV 格式的檔案', 'error'); return;
    }
    const formData = new FormData();
    formData.append('file', file);
    try {
        showToast('正在解析 CSV...');
        const res = await fetch('/api/windrose/upload-csv', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.ok) throw new Error(data.detail || '解析失敗');
        applyParsedCsv(data.csv_text, data.info, file.name);
    } catch (err) {
        showToast('CSV 解析失敗：' + err.message, 'error');
    }
}

function applyParsedCsv(csvText, info, filename) {
    state.csvText = csvText;
    state.csvInfo = info;
    updateColumnSelectors(info);
    renderDataPreview(info.preview);
    dataInfo.textContent = `${filename}  |  ${info.rows} 筆`;
    dataInfo.style.display = '';
    mappingSection.style.display = '';
    showToast(`CSV 載入：${info.rows} 筆資料`, 'success');
}

function updateColumnSelectors(info) {
    const cols = info.columns;
    console.log("[Diagnostic] 偵測到的原始欄位:", cols);

    const fillColSelect = (sel, keywords, indexFallback) => {
        if (!sel) return;
        sel.innerHTML = '';
        let bestMatch = '';

        cols.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            sel.appendChild(opt);

            // 智慧匹配關鍵字
            if (!bestMatch) {
                const cl = c.toLowerCase();
                keywords.forEach(k => {
                    if (cl.includes(k.toLowerCase())) bestMatch = c;
                });
            }
        });

        // 優先使用關鍵字，次之使用索引備案
        if (bestMatch) {
            sel.value = bestMatch;
            console.log(`[Diagnostic] 欄位 ${sel.id} 匹配關鍵字成功: ${bestMatch}`);
        } else if (cols[indexFallback] !== undefined) {
            sel.value = cols[indexFallback];
            console.log(`[Diagnostic] 欄位 ${sel.id} 使用預設索引 [${indexFallback}]: ${cols[indexFallback]}`);
        }
    };

    // 1. 風向: 優先關鍵字，預設第 1 欄 (Index 0)
    fillColSelect(dirColSel, ['wind_dir', 'wd', '風向', 'direction', 'deg', 'dir', 'θ'], 0);

    // 2. 風速: 優先關鍵字，預設第 2 欄 (Index 1)
    fillColSelect(speedColSel, ['wind_speed', 'ws', '風速', 'speed', 'm/s', 'spd', 'v'], 1);

    // 3. 濃度: 優先關鍵字，預設第 3 欄 (Index 2)
    fillColSelect(concColSel, ['pm2.5', 'pm10', 'no2', 'so2', 'o3', 'conc', '濃度', '污染', 'value', 'ppbv', 'μg', 'ug'], 2);

    nDirsSel.value = String(state.nDirs);
}

function renderDataPreview(rows) {
    if (!rows || rows.length === 0) { dataPreview.innerHTML = '<p class="project-empty">無預覽資料</p>'; return; }
    const keys = Object.keys(rows[0]);
    const thead = `<tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr>`;
    const tbody = rows.map(r => `<tr>${keys.map(k => `<td>${r[k] ?? ''}</td>`).join('')}</tr>`).join('');
    dataPreview.innerHTML = `<table class="preview-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

// ============================================================
// 手動輸入
// ============================================================
window.loadManualData = function() {
    const raw = $id('manualData').value.trim();
    if (!raw) { showToast('請輸入資料', 'error'); return; }
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) { showToast('至少需要標題列與一筆資料', 'error'); return; }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const formData = new FormData();
    formData.append('file', blob, 'manual.csv');

    fetch('/api/windrose/upload-csv', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (!data.ok) throw new Error(data.detail);
            applyParsedCsv(data.csv_text, data.info, '手動輸入資料');
        })
        .catch(err => showToast('解析失敗：' + err.message, 'error'));
};

// ============================================================
// 同步左側 nDirs 下拉
// ============================================================
// ============================================================
// ============================================================
// 設定同步與事件監聽修復
// ============================================================
nDirsTopSel.addEventListener('change', () => {
    nDirsSel.value = nDirsTopSel.value;
    state.nDirs = parseInt(nDirsTopSel.value);
});
nDirsSel.addEventListener('change', () => {
    nDirsTopSel.value = nDirsSel.value;
    state.nDirs = parseInt(nDirsSel.value);
});

speedBinsInput.addEventListener('input', () => {
    const raw = speedBinsInput.value.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
    if (raw.length >= 2) {
        state.speedBins = raw;
        renderBinsPreview();
    }
});

freqColorscaleSel.addEventListener('change', () => {
    state.freqColorscale = freqColorscaleSel.value;
    if (state.freqResult) redrawCharts();
});

concColorscaleSel.addEventListener('change', () => {
    state.concColorscale = concColorscaleSel.value;
    if (state.concResult) redrawCharts();
});

// ============================================================
// 級距預覽
// ============================================================
function renderBinsPreview() {
    const bins = state.speedBins;
    const colors = makeColorArray(bins.length - 1 + 1, state.freqColorscale);
    $id('speedBinsPreview').innerHTML = bins.map((b, i) => {
        const next = bins[i + 1];
        if (next === undefined) return '';
        return `<span class="bin-tag" style="background:${colors[i]}">${b}-${next}</span>`;
    }).join('');
}

// ============================================================
// 繪製圖表
// ============================================================
computeBtn.addEventListener('click', renderChart);

async function renderChart() {
    if (!state.csvText) { showToast('請先上傳 CSV 資料', 'error'); return; }
    state.nDirs = parseInt(nDirsSel.value);
    state.freqColorscale = freqColorscaleSel.value;
    state.concColorscale = concColorscaleSel.value;

    // 解析 speed bins
    const rawSpeed = state.speedBins;
    renderBinsPreview();

    // 產生風速標籤
    const speedLabels = rawSpeed.slice(0, -1).map((b, i) =>
        i === rawSpeed.length - 2 ? `>${b}` : `${b}-${rawSpeed[i+1]}`
    );



    showToast('計算中...');

    const basePayload = {
        csv_data: state.csvText,
        dir_col: dirColSel.value,
        speed_col: speedColSel.value,
        conc_col: concColSel.value,
        n_dirs: state.nDirs,
        speed_bins: rawSpeed,
        speed_labels: speedLabels,
    };

    try {
        // 兩個 API 同步呼叫
        const [freqRes, concRes] = await Promise.all([
            fetch('/api/windrose/compute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...basePayload, mode: 'frequency' })
            }),
            fetch('/api/windrose/compute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...basePayload, mode: '3d_concentration' })
            }),
        ]);

        const freqData = await freqRes.json();
        const concData = await concRes.json();

        if (!freqData.ok) throw new Error(freqData.detail || '風花圖計算失敗');
        if (!concData.ok) throw new Error(concData.detail || '濃度風花圖計算失敗');

        state.freqResult = freqData.data;
        state.concResult = concData.data;

        redrawCharts();
        showToast('風花圖繪製完成！', 'success');
    } catch (err) {
        showToast('計算失敗：' + err.message, 'error');
    }
}

function redrawCharts() {
    chartPlaceholder.style.display = 'none';
    dualChart.style.display = 'grid'; // 恢復為並排網格

    // 統計列
    statsBar.style.display = 'flex';
    if (state.freqResult || state.concResult) {
        $id('statRecords').textContent = `${(state.freqResult || state.concResult).total_records} 筆資料`;
    }
    if (state.freqResult) {
        $id('statDirs').textContent = `${state.freqResult.directions.length} 方位`;
    }
    if (state.concResult) {
        $id('statConc').textContent = `濃度 ${state.concResult.conc_min} ~ ${state.concResult.conc_max}`;
    }

    // 讓瀏覽器先繪製 flex 排版，下一幀再繪圖，確保 Plotly 抓到正確容器寬高，防止破圖與偏移
    requestAnimationFrame(() => {
        if (state.freqResult) drawFreqChart(state.freqResult);
        if (state.concResult) drawConcChart(state.concResult);
    });
}

// ============================================================
// 繪製風花圖（頻率）
// ============================================================
function drawFreqChart(result) {
    const { directions, series } = result;
    const showLabels = showFreqLabels.checked;
    const showGrid   = true; 
    const colors = makeColorArray(series.length, state.freqColorscale);

    const traces = series.map((s, i) => ({
        type: 'barpolar',
        r: s.values,
        theta: directions,
        name: s.name,
        marker: { color: colors[i], line: { color: '#ffffff', width: 0.5 } },
        hovertemplate: '<b>%{theta}</b><br>%{r:.2f}%<extra>' + s.name + '</extra>',
        opacity: 0.88,
    }));

    const layout = makePolarLayout(freqTitleInput.value || '風花圖', showGrid);
    if (layout.polar && layout.polar.radialaxis) {
        layout.polar.radialaxis.showticklabels = showLabels;
    }
    Plotly.react('freqChart', traces, layout, { responsive: true, displayModeBar: false, transparent: true });
}

// ============================================================
// 繪製污染濃度風花圖（仿 R 語言 openair polarPlot 呈現方式）
// ============================================================
function drawConcChart(result) {
    const { mode, grid, points, max_speed, conc_min, conc_max } = result;
    const showGrid = true; 
    const showLabels = showConcLabels.checked;

    if (!grid && mode !== 'scatter') return;

    const steps = 4;
    const stepSize = max_speed / steps;
    const shapes = [];
    const annotations = [];

    // 手動繪製極座標底圖
    if (showGrid) {
        // 同心圓與風速標示
        for (let i = 1; i <= steps; i++) {
            const r = i * stepSize;
            shapes.push({
                type: 'circle',
                x0: -r, y0: -r, x1: r, y1: r,
                line: { color: '#e0e0e0', width: 1 },
                layer: 'below'
            });
            
            if (showLabels) {
                annotations.push({
                    x: r, y: 0, 
                    text: r.toFixed(1) + (i === steps ? ' m/s' : ''),
                    showarrow: false,
                    font: { color: '#0050b3', size: 10 }, 
                    xanchor: 'left', 
                    yanchor: 'bottom',
                    xshift: 5, // 靠左對齊並向右偏移，避免壓線與擁擠
                    yshift: 2, 
                });
            }
        }
        
        // 放射線與方位羅盤
        const directions = state.nDirs === 16 
            ? ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
            : ["N","NE","E","SE","S","SW","W","NW"];
        
        directions.forEach((dir, i) => {
            const angleDeg = i * (360 / directions.length);
            const angleRad = (90 - angleDeg) * Math.PI / 180;
            const xl = max_speed * Math.cos(angleRad);
            const yl = max_speed * Math.sin(angleRad);
            
            // 放射線
            shapes.push({
                type: 'line',
                x0: 0, y0: 0, x1: xl, y1: yl,
                line: { color: '#e0e0e0', width: 1 },
                layer: 'below'
            });
            
            // 標籤 (移得更外面一點，縮小字體)
            const labelRadius = max_speed * 1.25; 
            annotations.push({
                x: labelRadius * Math.cos(angleRad),
                y: labelRadius * Math.sin(angleRad),
                text: dir,
                showarrow: false,
                font: { color: '#666666', size: 9 }
            });
        });
    }

    let traces = [];
    if (mode === 'scatter') {
        const x = points.map(p => p.r * Math.cos((90 - p.theta) * Math.PI / 180));
        const y = points.map(p => p.r * Math.sin((90 - p.theta) * Math.PI / 180));
        const v = points.map(p => p.v);
        
        const multiplier = parseFloat(document.getElementById('markerSizeMultiplier')?.value) || 1.0;
        
        traces.push({
            type: 'scatter',
            x: x,
            y: y,
            mode: 'markers',
            marker: {
                size: v.map(val => {
                    const base = ((val - conc_min) / (conc_max - conc_min || 1) * 20 + 5) * multiplier;
                    return Math.min(base, 200); // Allow larger caps
                }),
                color: v,
                colorscale: state.concColorscale,
                showscale: true,
                colorbar: {
                    title: { text: '濃度', font: { color: '#333333', size: 11 } },
                    tickfont: { color: '#333333', size: 10 },
                    len: 0.8,
                    thickness: 12,
                },
                opacity: 0.8,
                line: { color: '#000000', width: 0.5 }
            },
            text: v.map(val => `濃度: ${val.toFixed(2)}`),
            hovertemplate: '%{text}<br>風速: %{r:.1f}<extra></extra>'
        });

        // 加入備註說明
        annotations.push({
            xref: 'paper', yref: 'paper',
            x: 0.5, y: -0.18, // 稍微向下調整以便配合增加的 margin.b
            text: '※ 備註：樣本數不足 100 筆，僅呈現原始濃度分佈，不進行平均值計算。',
            showarrow: false,
            font: { color: '#d9363e', size: 11 } // 更深的紅色以適應白底
        });
    } else {
        // 將超出圓陣列的 null 排除在填色之外
        traces.push({
            type: 'contour',
            x: grid.x,
            y: grid.y,
            z: grid.z,
            colorscale: state.concColorscale, 
            ncontours: 120,      
            zmin: conc_min,
            zmax: conc_max,
            contours: {
                coloring: 'fill',
                showlines: false, 
            },
            colorbar: {
                title: { text: '平均濃度', font: { color: '#333333', size: 11 } },
                tickfont: { color: '#333333', size: 10 },
                len: 0.8,
                thickness: 12,
                bgcolor: 'rgba(255, 255, 255, 0.85)',
                outlinecolor: '#cccccc',
            },
            hovertemplate: '平均濃度: %{z:.1f}<extra></extra>'
        });
    }

    // 完全客製化直角卡氏底圖，模擬極座標佈局
    const layout = {
        title: { text: concTitleInput.value || '污染濃度分析', font: { color: '#333333', size: 16, weight: 'bold' }, pad: { t: 4 } },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)', 
        margin: { t: 60, b: 100, l: 40, r: 40 },
        font: { family: 'Inter, sans-serif', color: '#333333' },
        xaxis: {
            range: [-max_speed * 1.3, max_speed * 1.3],
            showgrid: false, zeroline: false, visible: false,
            scaleanchor: 'y', scaleratio: 1, 
        },
        yaxis: {
            range: [-max_speed * 1.3, max_speed * 1.3],
            showgrid: false, zeroline: false, visible: false,
            scaleanchor: 'x', scaleratio: 1, 
        },
        shapes: shapes,
        annotations: annotations
    };
    
    Plotly.react('concChart', traces, layout, { responsive: true, displayModeBar: false, transparent: true });
}

// ============================================================
// 共用極坐標版面
// ============================================================
function makePolarLayout(title, showGrid) {
    const gc = showGrid ? '#e0e0e0' : 'transparent';
    return {
        title: { text: title, font: { color: '#333333', size: 16, weight: 'bold' }, pad: { t: 4 } },
        polar: {
            bgcolor: '#ffffff',
            angularaxis: {
                direction: 'clockwise',
                rotation: 90,
                tickfont: { color: '#666666', size: 9 },
                linecolor: gc,
                gridcolor: gc,
                layer: 'below traces'
            },
            radialaxis: {
                tickfont: { color: '#666666', size: 9 },
                ticksuffix: '%',
                linecolor: gc,
                gridcolor: gc,
                showline: showGrid,
                layer: 'below traces'
            }
        },
        legend: {
            font: { color: '#333333', size: 11 },
            bgcolor: 'rgba(255, 255, 255, 0.9)',
            bordercolor: '#cccccc',
            borderwidth: 1,
            orientation: 'h',
            x: 0.5,
            xanchor: 'center',
            y: -0.18,
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 60, b: 100, l: 40, r: 40 }, 

        font: { family: 'Inter, sans-serif', color: '#333333' },
    };
}

// ============================================================
// 色板工具
// ============================================================
function makeColorArray(n, scaleName) {
    const palettes = {
        Plasma: ['#0d0887','#7201a8','#b12a90','#e16462','#fca636','#f0f921'],
        Viridis: ['#440154','#31688e','#35b779','#fde725'],
        Turbo: ['#30123b','#466be1','#28bbec','#66f68d','#d1f83c','#fbbe23','#ef6a06','#a01d02','#7a0403'],
        Jet: ['#00007f','#0000ff','#00ffff','#ffff00','#ff0000'],
        'RdYlGn_r': ['#006837','#78c679','#ffff00','#fd8d3c','#a50026'],
        Blues: ['#f7fbff','#6baed6','#2171b5','#08306b'],
        Reds: ['#fff5f0','#fc8d59','#d7301f','#67000d'],
    };
    const pal = palettes[scaleName] || palettes.Plasma;
    const result = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.round((i / Math.max(n - 1, 1)) * (pal.length - 1));
        result.push(pal[idx]);
    }
    return result;
}

// ============================================================
// 套用設定
// ============================================================
applySettingsBtn.addEventListener('click', () => {
    state.freqColorscale = freqColorscaleSel.value;
    state.concColorscale = concColorscaleSel.value;
    state.nDirs = parseInt(nDirsSel.value);
    if (state.freqResult || state.concResult) {
        redrawCharts();
        showToast('設定已更新', 'success');
    }
});

const markerSizeMultiplierInputDOM = document.getElementById('markerSizeMultiplier'); 
if (markerSizeMultiplierInputDOM) {
    markerSizeMultiplierInputDOM.addEventListener('input', () => {
        if (state.freqResult || state.concResult) {
            redrawCharts();
        }
    });
}

// ============================================================
// 匯出 PNG
// ============================================================
// ============================================================
// 匯出 PNG (增強版：白底、大字體、高解析度)
// ============================================================
exportPngBtn.addEventListener('click', async () => {
    if (!state.freqResult && !state.concResult) {
        showToast('請先繪製風花圖', 'error'); return;
    }
    
    const timestamp = new Date().toISOString().slice(0, 10);
    showToast('正在準備截圖...', 'info');

    const exportTask = async (id, namePrefix) => {
        const gd = document.getElementById(id);
        if (!gd) return;
        
        const card = gd.closest('.chart-card');
        if (!card) return;

        try {
            const gdImage = await Plotly.toImage(gd, { format: 'png', width: gd.clientWidth, height: gd.clientHeight });
            const img = document.createElement('img');
            img.src = gdImage;
            img.style.width = gd.clientWidth + 'px';
            img.style.height = gd.clientHeight + 'px';
            img.style.objectFit = 'contain';
            
            // 替換圖表為靜態圖片以供 html2canvas 完美截圖
            const prevDisp = gd.style.display;
            gd.style.display = 'none';
            card.appendChild(img);

            // 隱藏標題與邊框以符合乾淨的匯出
            const titleEl = card.querySelector('.chart-card-title');
            let prevTitleDisp = '';
            if (titleEl) {
                prevTitleDisp = titleEl.style.display;
                titleEl.style.display = 'none';
            }
            const origBorder = card.style.border;
            const origShadow = card.style.boxShadow;
            card.style.border = 'none';
            card.style.boxShadow = 'none';

            const canvas = await html2canvas(card, {
                scale: 2, // 提高解析度
                backgroundColor: '#ffffff', // 確保白底
                useCORS: true
            });

            // 還原狀態
            if (titleEl) titleEl.style.display = prevTitleDisp;
            card.style.border = origBorder;
            card.style.boxShadow = origShadow;

            card.removeChild(img);
            gd.style.display = prevDisp;

            const dataUrl = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.download = `${namePrefix}_${timestamp}.png`;
            link.href = dataUrl;
            link.click();
        } catch (err) {
            console.error('Export error:', err);
            showToast('截圖匯出失敗', 'error');
        }
    };

    if (state.freqResult) await exportTask('freqChart', 'windrose_freq');
    if (state.concResult) await exportTask('concChart', 'windrose_conc');
    
    showToast('PNG 截圖匯出完成', 'success');
});


// ============================================================
// 專案管理
// ============================================================
async function loadProjectList() {
    try {
        const res = await fetch('/api/windrose/projects');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        renderProjectList(data.projects || []);
    } catch (e) {
        console.error('載入專案列表出錯:', e);
        projectList.innerHTML = `<p class="project-empty">載入失敗: ${e.message}</p>`;
    }
}

function renderProjectList(projects) {
    if (!projects || !Array.isArray(projects) || !projects.length) {
        projectList.innerHTML = '<p class="project-empty">尚無儲存的專案</p>';
        return;
    }
    projectList.innerHTML = projects.map(p => {
        const d = new Date(p.updated_at).toLocaleDateString('zh-TW', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        const isActive = p.id === state.currentProjectId;
        return `<div class="project-item ${isActive ? 'active' : ''}" onclick="openProject('${p.id}')">
            <div class="project-info">
                <div class="project-item-name">${p.name}</div>
                <div class="project-item-date">📅 ${d}</div>
            </div>
            <div class="project-item-actions">
                <button type="button" class="btn-mini" onclick="event.stopPropagation();deleteProject('${p.id}')" title="刪除專案">🗑️</button>
            </div>
        </div>`;
    }).join('');
}

// 新增專案 (只重置狀態，不跳頁)
newProjectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.csvText = '';
    state.csvInfo = null;
    state.freqResult = null;
    state.concResult = null;
    state.currentProjectId = null;
    mappingSection.style.display = 'none';
    chartPlaceholder.style.display = '';
    dualChart.style.display = 'none';
    statsBar.style.display = 'none';
    dataInfo.style.display = 'none';
    dataPreview.innerHTML = '<p class="project-empty">尚未載入資料</p>';
    projectNameInput.value = '';
    freqTitleInput.value = '';
    concTitleInput.value = '';
    loadProjectList();
    showToast('已建立新專案', '');
});

window.openProject = async (id) => {
    try {
        const res = await fetch(`/api/windrose/projects/${id}`);
        const data = await res.json();
        if (!data.ok) throw new Error('載入失敗');
        const p = data.project;
        const s = p.settings || {};

        state.currentProjectId = p.id;
        projectNameInput.value = p.name;
        
        // 載入色帶設定 (支援舊版 fallback)
        if (s.freqColorscale) { 
            state.freqColorscale = s.freqColorscale; 
            freqColorscaleSel.value = s.freqColorscale; 
        } else if (s.colorscale) {
            state.freqColorscale = s.colorscale; 
            freqColorscaleSel.value = s.colorscale; 
        }

        if (s.concColorscale) { 
            state.concColorscale = s.concColorscale; 
            concColorscaleSel.value = s.concColorscale; 
        } else if (s.colorscale) {
            state.concColorscale = s.colorscale; 
            concColorscaleSel.value = s.colorscale; 
        }

        // 載入標題設定
        if (s.freqTitle !== undefined) freqTitleInput.value = s.freqTitle;
        if (s.concTitle !== undefined) concTitleInput.value = s.concTitle;

        if (s.nDirs) { state.nDirs = s.nDirs; nDirsSel.value = String(s.nDirs); nDirsTopSel.value = String(s.nDirs); }
        if (s.speedBins) { state.speedBins = s.speedBins; speedBinsInput.value = s.speedBins.join(','); }

        if (p.csv_data) {
            const blob = new Blob([p.csv_data], { type: 'text/csv' });
            const formData = new FormData();
            formData.append('file', blob, p.name + '.csv');
            const r2 = await fetch('/api/windrose/upload-csv', { method: 'POST', body: formData });
            const d2 = await r2.json();
            if (d2.ok) {
                applyParsedCsv(p.csv_data, d2.info, p.name);
                if (s.dirCol) dirColSel.value = s.dirCol;
                if (s.speedCol) speedColSel.value = s.speedCol;
                if (s.concCol) concColSel.value = s.concCol;
            }
        }
        loadProjectList();
        showToast('已載入專案：' + p.name, 'success');
    } catch (err) {
        showToast('載入失敗：' + err.message, 'error');
    }
};

window.deleteProject = async (id) => {
    if (!confirm('確定要刪除此專案嗎？')) return;
    try {
        await fetch(`/api/windrose/projects/${id}`, { method: 'DELETE' });
        if (state.currentProjectId === id) state.currentProjectId = null;
        loadProjectList();
        showToast('專案已刪除');
    } catch (err) {
        showToast('刪除失敗', 'error');
    }
};

// 儲存
confirmSaveBtn.addEventListener('click', async () => {
    if (!state.csvText) { showToast('請先上傳 CSV 資料', 'error'); return; }
    const name = projectNameInput.value.trim() || '未命名專案';
    const settings = {
        freqColorscale: state.freqColorscale,
        concColorscale: state.concColorscale,
        freqTitle: freqTitleInput.value,
        concTitle: concTitleInput.value,
        nDirs: state.nDirs,
        speedBins: state.speedBins,
        dirCol: dirColSel.value,
        speedCol: speedColSel.value,
        concCol: concColSel.value,
    };
    try {
        const res = await fetch('/api/windrose/projects/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: state.currentProjectId, name, csv_data: state.csvText, settings, description: '' })
        });
        const data = await res.json();
        if (!data.ok) throw new Error('儲存失敗');
        state.currentProjectId = data.id;
        loadProjectList();
        showToast('專案已儲存：' + name, 'success');
    } catch (err) {
        showToast('儲存失敗：' + err.message, 'error');
    }
});

saveProjectBtn.addEventListener('click', () => confirmSaveBtn.click());

// ============================================================
// 初始化
// ============================================================
renderBinsPreview();
loadProjectList();

// API Key不再儲存於本地端以防內網發布遭盜用

// ============================================================
// AI 分析
// ============================================================
async function startAIAnalysis() {
    const key = $id('apiKeyInput').value?.trim();
    if (!key) {
        showToast('請先輸入 Gemini API Key', 'error'); return;
    }
    if (!state.freqResult && !state.concResult) {
        showToast('請先產生分析圖表', 'error'); return;
    }

    const btn = $id('aiBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '🤖 AI 正在分析中...';
    btn.disabled = true;

    try {
        const aiData = {
            n_dirs: state.nDirs,
            speed_bins: state.speedBins
        };

        if (state.freqResult) {
            aiData.frequency_summary = {
                total_records: state.freqResult.total_records,
                directions: state.freqResult.directions,
                // 提供每個方位的總累積頻率作為參考
                dir_frequencies: state.freqResult.directions.map((d, i) => {
                    const sum = state.freqResult.series.reduce((acc, s) => acc + s.values[i], 0);
                    return { dir: d, freq: sum.toFixed(2) + '%' };
                })
            };
        }

        if (state.concResult) {
            aiData.concentration_summary = {
                total_records: state.concResult.total_records,
                conc_min: state.concResult.conc_min,
                conc_max: state.concResult.conc_max,
                max_speed: state.concResult.max_speed
            };
        }

        const res = await fetch('/api/windrose/ai-analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: key,
                data: aiData
            })
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || '伺服器錯誤');
        }

        const result = await res.json();
        
        $id('aiReportContent').innerHTML = marked.parse(result.report);
        $id('aiReportContainer').style.display = 'flex';
        $id('aiReportContainer').scrollIntoView({ behavior: 'smooth' });
        showToast('AI 分析報告已完成', 'success');

    } catch (err) {
        console.error(err);
        showToast('AI 分析失敗：' + err.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function closeAiReport() {
    $id('aiReportContainer').style.display = 'none';
}

window.startAIAnalysis = startAIAnalysis;
window.closeAiReport = closeAiReport;
