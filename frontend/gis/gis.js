// 初始化地圖
let map = L.map('map').setView([23.5, 121], 7);
let osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
}).addTo(map);

let satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
});

// 指北針圖層
let northArrowControl = L.control({position: 'topleft'});
northArrowControl.onAdd = function (map) {
    let div = L.DomUtil.create('div', 'north-arrow-control');
    div.innerHTML = '<span>🧭</span>';
    div.title = "指北針";
    return div;
};

// 初始根據設定決定是否加入指北針
if (document.getElementById('config-show-north').checked) {
    northArrowControl.addTo(map);
}

document.getElementById('config-show-north').addEventListener('change', function(e) {
    if (e.target.checked) {
        northArrowControl.addTo(map);
    } else {
        map.removeLayer(northArrowControl);
    }
});

// 切換底圖
document.getElementById('basemap-select').addEventListener('change', function(e) {
    if(e.target.value === 'satellite') {
        map.removeLayer(osmLayer);
        satelliteLayer.addTo(map);
    } else {
        map.removeLayer(satelliteLayer);
        osmLayer.addTo(map);
    }
});

// 全域變數
let parsedData = [];
let currentOverlay = null; // 存放圖片
let currentGeoJson = null; // 存放 GeoJSON layer
let currentBounds = null;
let currentGeoJsonData = null; // 原始 json 資料供下載
let rawAnalysisData = {}; // 保留最後一次分析的參數供 AI 用
let markersGroup = L.layerGroup().addTo(map); // 用於管理資料點標記
let currentProjectId = null; // 目前編輯中的專案 ID

// 處理檔案拖曳與上傳
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

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
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv') {
        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            complete: function(results) {
                setupMapping(results.data, file.name);
            }
        });
    } else if (ext === 'xlsx' || ext === 'xls') {
        const reader = new FileReader();
        reader.onload = function(e) {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const firstSheet = workbook.SheetNames[0];
            const jsObj = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet]);
            setupMapping(jsObj, file.name);
        };
        reader.readAsArrayBuffer(file);
    } else {
        alert("不支援的檔案格式，請上傳 CSV 或 Excel");
    }
}

function setupMapping(data, filename) {
    parsedData = data.filter(r => Object.keys(r).length > 1); // 過濾空行
    if(parsedData.length === 0) {
        alert("資料為空或解析失敗");
        return;
    }
    
    // 取第一筆取得欄位
    const headers = Object.keys(parsedData[0]);
    
    // 更新 UI
    document.getElementById('drop-zone').querySelector('p').innerText = `已選取: ${filename} (${parsedData.length} 筆)`;
    document.getElementById('mapping-section').style.display = 'block';
    
    const fillSelect = (id, defaultKeywords, indexFallback) => {
        const sel = document.getElementById(id);
        sel.innerHTML = '';
        let bestMatch = '';
        headers.forEach(h => {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h;
            sel.appendChild(opt);
            
            // 嘗試自動匹配
            if(!bestMatch) {
                const hl = h.toLowerCase();
                defaultKeywords.forEach(k => {
                    if (hl.includes(k)) bestMatch = h;
                });
            }
        });
        
        if (bestMatch) {
            sel.value = bestMatch;
        } else if (headers[indexFallback] !== undefined) {
            // 如果沒匹配到關鍵字，使用預設索引 (第一、二、三欄)
            sel.value = headers[indexFallback];
        }
    };
    
    fillSelect('col-x', ['xtwd97', 'lon', 'x', '經度'], 0);
    fillSelect('col-y', ['ytwd97', 'lat', 'y', '緯度'], 1);
    fillSelect('col-v', ['value', 'pm2.5', 'val', '濃度', '高程', 'elevation', 'no2'], 2);

    // [自動同步] 載入資料後，將「污染物類別」預設為「數值」欄位的名稱
    const colV = document.getElementById('col-v');
    const pollutantInput = document.getElementById('pollutant-type');
    if (colV && pollutantInput) {
        pollutantInput.value = colV.value;
    }

    // 初始渲染標記
    renderDataMarkers();
}

// [事件監聽] 當「數值」欄位選單變更時，自動更新「污染物類別」
document.getElementById('col-v').addEventListener('change', function(e) {
    const pollutantInput = document.getElementById('pollutant-type');
    if (pollutantInput) {
        pollutantInput.value = e.target.value;
    }
});

// 渲染資料點標記 (可拖曳)
function renderDataMarkers() {
    markersGroup.clearLayers();
    if (!parsedData || parsedData.length === 0) return;

    const colX = document.getElementById('col-x').value;
    const colY = document.getElementById('col-y').value;
    const colV = document.getElementById('col-v').value;
    const showMarkers = document.getElementById('config-show-markers').checked;

    parsedData.forEach((row, index) => {
        let rawX = parseFloat(row[colX]);
        let rawY = parseFloat(row[colY]);
        let v = parseFloat(row[colV]);

        if (!isNaN(rawX) && !isNaN(rawY)) {
            // 自動偵測與轉換座標 (WGS84 才能顯示在地圖上)
            let displayLat, displayLon;
            let isTWD97 = (rawX > 100000 && rawY > 1000000);

            if (isTWD97) {
                const wgs = twd97ToWgs84(rawX, rawY);
                displayLon = wgs.lon;
                displayLat = wgs.lat;
            } else {
                displayLon = rawX;
                displayLat = rawY;
            }

            const marker = L.marker([displayLat, displayLon], {
                draggable: true,
                title: `點 ${index + 1}`
            });

            marker.on('dragend', function(e) {
                const newPos = e.target.getLatLng();
                // 校正後統一存回為 WGS84 經緯度，以確保後續渲染正確
                parsedData[index][colX] = newPos.lng;
                parsedData[index][colY] = newPos.lat;
                console.log(`點 ${index + 1} 校正至:`, newPos);
                
                // 顯示簡易提示
                marker.setPopupContent(`
                    <strong>數據點 #${index + 1} (已校正)</strong><br>
                    數值: ${v}<br>
                    新座標: ${newPos.lng.toFixed(5)}, ${newPos.lat.toFixed(5)}
                `).openPopup();
            });

            marker.bindPopup(`
                <strong>數據點 #${index + 1}</strong><br>
                數值: ${v}<br>
                座標: ${displayLon.toFixed(5)}, ${displayLat.toFixed(5)}<br>
                <small>拖曳可人工修正位置</small>
            `);

            if (showMarkers) marker.addTo(markersGroup);
        }
    });
}

/**
 * TWD97 (TM2) 轉 WGS84 近似算法
 * 適合瀏覽器端標記呈現使用
 */
function twd97ToWgs84(x, y) {
    const a = 6378137.0;
    const b = 6356752.314245;
    const lon0 = 121 * Math.PI / 180;
    const k0 = 0.9999;
    const dx = 250000;
    
    const dy = 0;
    const e = Math.sqrt(1 - Math.pow(b, 2) / Math.pow(a, 2));
    
    x -= dx;
    y -= dy;
    
    const m = y / k0;
    const mu = m / (a * (1 - Math.pow(e, 2) / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256));
    const e1 = (1 - Math.sqrt(1 - Math.pow(e, 2))) / (1 + Math.sqrt(1 - Math.pow(e, 2)));
    
    const j1 = (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32);
    const j2 = (21 * Math.pow(e1, 2) / 16 - 55 * Math.pow(e1, 4) / 32);
    const j3 = (151 * Math.pow(e1, 3) / 96);
    const j4 = (1097 * Math.pow(e1, 4) / 512);
    
    const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu) + j3 * Math.sin(6 * mu) + j4 * Math.sin(8 * mu);
    
    const e2 = Math.pow(e, 2) / (1 - Math.pow(e, 2));
    const c1 = e2 * Math.pow(Math.cos(fp), 2);
    const t1 = Math.pow(Math.tan(fp), 2);
    const r1 = a * (1 - Math.pow(e, 2)) / Math.pow(1 - Math.pow(e, 2) * Math.pow(Math.sin(fp), 2), 1.5);
    const n1 = a / Math.sqrt(1 - Math.pow(e, 2) * Math.pow(Math.sin(fp), 2));
    const d = x / (n1 * k0);
    
    const q1 = n1 * Math.tan(fp) / r1;
    const q2 = (Math.pow(d, 2) / 2);
    const q3 = (5 + 3 * t1 + 10 * c1 - 4 * Math.pow(c1, 2) - 9 * e2) * Math.pow(d, 4) / 24;
    const q4 = (61 + 90 * t1 + 298 * c1 + 45 * Math.pow(t1, 2) - 3 * Math.pow(c1, 2) - 252 * e2) * Math.pow(d, 6) / 720;
    let lat = fp - q1 * (q2 - q3 + q4);
    
    const q5 = d;
    const q6 = (1 + 2 * t1 + c1) * Math.pow(d, 3) / 6;
    const q7 = (5 - 2 * c1 + 28 * t1 - 3 * Math.pow(c1, 2) + 8 * e2 + 24 * Math.pow(t1, 2)) * Math.pow(d, 5) / 120;
    let lon = lon0 + (q5 - q6 + q7) / Math.cos(fp);
    
    lat = lat * 180 / Math.PI;
    lon = lon * 180 / Math.PI;
    
    return { lat, lon };
}

// 供匯出使用的 TWD97 轉換
function wgs84ToTwd97_export(lon, lat) {
    const a = 6378137.0, b = 6356752.314245;
    const lon0 = 121 * Math.PI / 180, k0 = 0.9999, dx = 250000;
    const e = Math.sqrt(1 - Math.pow(b / a, 2));
    const lonRad = lon * Math.PI / 180, latRad = lat * Math.PI / 180;
    const v = a / Math.sqrt(1 - Math.pow(e * Math.sin(latRad), 2));
    const t = Math.pow(Math.tan(latRad), 2);
    const c = Math.pow(e, 2) / (1 - Math.pow(e, 2)) * Math.pow(Math.cos(latRad), 2);
    const A = (lonRad - lon0) * Math.cos(latRad);
    const M = a * ((1 - Math.pow(e, 2) / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256) * latRad - (3 * Math.pow(e, 2) / 8 + 3 * Math.pow(e, 4) / 32 + 45 * Math.pow(e, 6) / 1024) * Math.sin(2 * latRad) + (15 * Math.pow(e, 4) / 256 + 45 * Math.pow(e, 6) / 1024) * Math.sin(4 * latRad) - (35 * Math.pow(e, 6) / 3072) * Math.sin(6 * latRad));
    const x = dx + k0 * v * (A + (1 - t + c) * Math.pow(A, 3) / 6 + (5 - 18 * t + Math.pow(t, 2) + 72 * c - 58 * Math.pow(e, 2) / (1 - Math.pow(e, 2))) * Math.pow(A, 5) / 120);
    const y = k0 * (M + v * Math.tan(latRad) * (Math.pow(A, 2) / 2 + (5 - t + 9 * c + 4 * Math.pow(c, 2)) * Math.pow(A, 4) / 24 + (61 - 58 * t + Math.pow(t, 2) + 600 * c - 330 * Math.pow(e, 2) / (1 - Math.pow(e, 2))) * Math.pow(A, 6) / 720));
    return { x, y };
}

// 監聽標記顯示開關
document.getElementById('config-show-markers').addEventListener('change', function(e) {
    if (e.target.checked) {
        markersGroup.addTo(map);
    } else {
        map.removeLayer(markersGroup);
    }
});


// 手動資料載入
function loadManualData() {
    const text = document.getElementById('manual-data').value;
    Papa.parse(text, {
        header: true,
        dynamicTyping: true,
        complete: function(results) {
            setupMapping(results.data, "手動輸入資料");
            // 成功輸入後將捲軸拉到最上方，方便看到對應設定
            const panel = document.querySelector('.data-panel');
            if (panel) panel.scrollTop = 0;
        }
    });
}

// 線條粗細同步數字
document.getElementById('config-linewidth').addEventListener('input', function(e) {
    document.getElementById('lw-val').innerText = e.target.value;
});

// 透明度同步數字
document.getElementById('config-alpha').addEventListener('input', function(e) {
    document.getElementById('alpha-val').innerText = e.target.value;
    if(currentOverlay) {
        currentOverlay.setOpacity(e.target.value);
    }
});

// 生成按鈕
document.getElementById('generate-btn').addEventListener('click', async () => {
    if(!parsedData || parsedData.length === 0) {
        alert("請先載入並設定資料"); return;
    }
    
    const colX = document.getElementById('col-x').value;
    const colY = document.getElementById('col-y').value;
    const colV = document.getElementById('col-v').value;
    
    const payloadData = [];
    let validCount = 0;
    
    parsedData.forEach(row => {
        let x = parseFloat(row[colX]);
        let y = parseFloat(row[colY]);
        let v = parseFloat(row[colV]);
        if(!isNaN(x) && !isNaN(y) && !isNaN(v)) {
            payloadData.push({x, y, value: v});
            validCount++;
        }
    });
    
    if(payloadData.length < 4) {
        alert("有效數據點不足 (至少需要4點)"); return;
    }

    const btn = document.getElementById('generate-btn');
    btn.innerText = "處理中...";
    btn.disabled = true;

    try {
        const payload = {
            data: payloadData,
            method: document.getElementById('config-method').value,
            levels_step: parseFloat(document.getElementById('config-step').value) || 0,
            colormap: document.getElementById('config-cmap').value,
            alpha: parseFloat(document.getElementById('config-alpha').value),
            linewidth: parseFloat(document.getElementById('config-linewidth').value),
            smooth: document.getElementById('config-smooth').checked,
            pollutant: document.getElementById('pollutant-type').value,
            show_fill: document.getElementById('config-show-fill').checked,
            line_color: document.getElementById('config-linecolor').value,
            show_label: document.getElementById('config-show-label').checked,
            label_size: parseInt(document.getElementById('config-labelsize').value) || 12,
            line_style: document.getElementById('config-linestyle').value
        };

        const res = await fetch('/api/gis/analyze', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        
        if(!res.ok) throw new Error(await res.text());
        const result = await res.json();
        
        // 儲存原始資料供 AI / 匯出 用
        rawAnalysisData = {
            ...payload, 
            min_v: result.min_v,
            max_v: result.max_v,
            center_lat: (result.bounds[0][0] + result.bounds[1][0]) / 2,
            center_lon: (result.bounds[0][1] + result.bounds[1][1]) / 2
        };
        currentGeoJsonData = result.geojson;

        // 繪製結果到地圖
        drawResultOnMap(result.image_base64, result.bounds, result.geojson, payload.alpha);
        
        // 更新 Overlays
        updateMapOverlays(payload);
        
    } catch(err) {
        console.error(err);
        alert(`處理失敗: \n${err.message}`);
    } finally {
        btn.innerText = "🚀 生成等濃度/高程圖";
        btn.disabled = false;
    }
});

function updateMapOverlays(payload) {
    const titleBox = document.getElementById('map-title-box');
    const legendBox = document.getElementById('map-legend-box');
    const titleInput = document.getElementById('config-title').value.trim();

    // 1. 更新標題
    if (titleInput) {
        titleBox.innerText = titleInput;
        titleBox.style.display = 'block';
    } else {
        titleBox.style.display = 'none';
    }

    // 2. 更新圖例
    if (rawAnalysisData.min_v !== undefined) {
        let html = `<div class="legend-title">${payload.pollutant || '數值'}</div>`;
        
        // 色帶 (只有在顯示塗滿區域時才出現)
        if (payload.show_fill) {
            html += `
            <div class="legend-gradient-container">
                <div class="legend-gradient" style="background: linear-gradient(to top, ${getGradientForCmap(payload.colormap)});"></div>
                <div class="legend-labels">
                    <span>${rawAnalysisData.max_v.toFixed(1)}</span>
                    <span>${((rawAnalysisData.max_v + rawAnalysisData.min_v)/2).toFixed(1)}</span>
                    <span>${rawAnalysisData.min_v.toFixed(1)}</span>
                </div>
            </div>`;
        }
        
        // 等濃度線資訊
        const lineStyleMap = { 'solid': 'solid', 'dashed': 'dashed', 'dotted': 'dotted' };
        html += `
            <div class="legend-line-row">
                <div class="legend-item-row">
                    <div class="legend-line-sample" style="border-bottom-style: ${lineStyleMap[payload.line_style] || 'solid'}; border-bottom-color: ${payload.line_color}; border-bottom-width: ${payload.linewidth}px;"></div>
                    <span>等值線 (${payload.line_style})</span>
                </div>
            </div>
        `;
        
        legendBox.innerHTML = html;
        legendBox.style.display = 'block';
    } else {
        legendBox.style.display = 'none';
    }
}

// 專業 GIS 匯出功能
let lastExportedBase64 = "";

async function exportProfessionalImage() {
    if (!currentOverlay) {
        alert("請先生成成果圖再匯出"); return;
    }

    const modal       = document.getElementById('export-modal');
    const previewImg  = document.getElementById('export-preview-img');
    previewImg.src    = '';
    modal.style.display = 'flex';

    // 暫存隱藏的元素清單，方便後續恢復
    const hiddenEls = [];

    try {
        // ── 1. 暫時隱藏 Leaflet 控制 UI (縮放/指北針/版權)，保留標題框與圖例框 ──
        document.querySelectorAll('.leaflet-control-container').forEach(el => {
            el.style.visibility = 'hidden';
            hiddenEls.push(el);
        });

        // ── 2. html2canvas 擷取地圖 (含 OSM 底圖 + 等濃度線 + 標題 + 圖例) ──
        const mapEl = document.getElementById('map');
        const mapCanvas = await html2canvas(mapEl, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: '#e8f0f8',
            scale: 1
        });

        // 恢復控制 UI
        hiddenEls.forEach(el => { el.style.visibility = ''; });
        hiddenEls.length = 0;

        // ── 3. 建立帶邊距的輸出畫布 ──
        const ML = 90, MT = 20, MR = 20, MB = 68; // 左/上/右/下 邊距 px
        const W  = mapCanvas.width;
        const H  = mapCanvas.height;
        const outW = W + ML + MR;
        const outH = H + MT + MB;

        const finalCanvas = document.createElement('canvas');
        finalCanvas.width  = outW;
        finalCanvas.height = outH;
        const ctx = finalCanvas.getContext('2d');

        // 白底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);

        // 地圖本體
        ctx.drawImage(mapCanvas, ML, MT);

        // 地圖邊框
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ML, MT, W, H);

        // ── 4. 計算 TWD97 刻度 ──
        const bounds = map.getBounds();
        const sw     = bounds.getSouthWest();
        const ne     = bounds.getNorthEast();
        const twdSW  = wgs84ToTwd97(sw.lng, sw.lat);
        const twdNE  = wgs84ToTwd97(ne.lng, ne.lat);

        // ── 精確計算座標軸邊界與轉換 ──
        const topLeft = map.containerPointToLatLng([0, 0]);
        const bottomRight = map.containerPointToLatLng([W, H]);
        
        const twdTL = wgs84ToTwd97_export(topLeft.lng, topLeft.lat);
        const twdBR = wgs84ToTwd97_export(bottomRight.lng, bottomRight.lat);
        
        const twdMinX = Math.min(twdTL.x, twdBR.x);
        const twdMaxX = Math.max(twdTL.x, twdBR.x);
        const twdMinY = Math.min(twdTL.y, twdBR.y);
        const twdMaxY = Math.max(twdTL.y, twdBR.y);
        
        const stepX = niceStep(twdMaxX - twdMinX);
        const stepY = niceStep(twdMaxY - twdMinY);
        
        const midTwdX = (twdMinX + twdMaxX) / 2;
        const midTwdY = (twdMinY + twdMaxY) / 2;

        ctx.fillStyle = '#222';
        ctx.font = '11px Arial';
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;

        // ── X 軸刻度 (下方) ──
        for (let tx = Math.ceil(twdMinX / stepX) * stepX; tx <= twdMaxX; tx += stepX) {
            const wgs = twd97ToWgs84(tx, midTwdY);
            const pt = map.latLngToContainerPoint([wgs.lat, wgs.lon]);
            const px = ML + pt.x;

            if (pt.x < 0 || pt.x > W) continue;

            ctx.beginPath(); ctx.moveTo(px, MT + H); ctx.lineTo(px, MT + H + 6); ctx.stroke();
            ctx.save();
            ctx.translate(px + 2, MT + H + 10);
            ctx.rotate(Math.PI / 4);
            ctx.fillText(Math.round(tx), 0, 0);
            ctx.restore();
        }

        // ── Y 軸刻度 (左方) ──
        for (let ty = Math.ceil(twdMinY / stepY) * stepY; ty <= twdMaxY; ty += stepY) {
            const wgs = twd97ToWgs84(midTwdX, ty);
            const pt = map.latLngToContainerPoint([wgs.lat, wgs.lon]);
            const py = MT + pt.y;

            if (pt.y < 0 || pt.y > H) continue;

            ctx.beginPath(); ctx.moveTo(ML, py); ctx.lineTo(ML - 6, py); ctx.stroke();
            ctx.textAlign = 'right';
            ctx.fillText(Math.round(ty), ML - 8, py + 4);
        }

        // ── 軸標題 ──
        ctx.fillStyle = '#333';
        ctx.font = 'bold 12px Arial, sans-serif';

        // X 軸標題
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('TWD97 E (m)', ML + W / 2, outH - 3);

        // Y 軸標題 (旋轉)
        ctx.save();
        ctx.translate(13, MT + H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('TWD97 N (m)', 0, 0);
        ctx.restore();

        // ── 5. 指北針 (地圖右上角內側) ──
        if (document.getElementById('config-show-north').checked) {
            drawNorthArrowCanvas(ctx, ML + W - 52, MT + 56, 25);
        }

        // ── 完成 ──
        lastExportedBase64 = finalCanvas.toDataURL('image/png');
        previewImg.src = lastExportedBase64;

    } catch (err) {
        console.error(err);
        hiddenEls.forEach(el => { el.style.visibility = ''; }); // 確保恢復
        alert(`匯出失敗: \n${err.message}`);
        closeExportModal();
    }
}

function closeExportModal() {
    document.getElementById('export-modal').style.display = 'none';
}

function downloadExportImage() {
    if(!lastExportedBase64) return;
    const a = document.createElement('a');
    a.href = lastExportedBase64;
    a.download = `GIS_Analysis_${new Date().getTime()}.png`;
    a.click();
}

function getGradientForCmap(cmap) {
    const cmaps = {
        'viridis': '#440154, #3b528b, #21918c, #5ec962, #fde725',
        'jet': '#00007f, #0000ff, #007fff, #7fff7f, #ff7f00, #ff0000, #7f0000',
        'plasma': '#0d0887, #7e03a8, #cc4778, #f89441, #f0f921',
        'magma': '#000004, #51127c, #b63679, #fb8861, #fcfdbf',
        'coolwarm': '#3b4cc0, #89a1ff, #dddddd, #ff9b76, #b40426'
    };
    return cmaps[cmap] || cmaps['viridis'];
}

function drawResultOnMap(imageBase64, bounds, geojson, alpha) {
    if(currentOverlay) map.removeLayer(currentOverlay);
    if(currentGeoJson) map.removeLayer(currentGeoJson);

    // 1. 加入 Image Overlay
    currentOverlay = L.imageOverlay(imageBase64, bounds, {opacity: alpha, interactive: false, zIndex: 10}).addTo(map);
    
    // 2. 加入 GeoJSON (不可見或微微可見，用來點擊查詢或其他互動)
    if(geojson && geojson.features.length > 0) {
        currentGeoJson = L.geoJSON(geojson, {
            style: { color: "transparent", weight: 5 }, // 實體線已畫在圖片上，這裡用隱形線做互動
            onEachFeature: function (feature, layer) {
                layer.bindTooltip(`數值: ${feature.properties.value}`, {sticky: true, direction: 'auto'});
            }
        }).addTo(map);
    }
    
    map.fitBounds(bounds);
}

// 匯出 GeoJSON
function exportGeoJSON() {
    if(!currentGeoJsonData) {
        alert("請先生成成果"); return;
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentGeoJsonData));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href",     dataStr     );
    dlAnchorElem.setAttribute("download", "contour.geojson");
    dlAnchorElem.click();
}

// 使用 html2canvas 擷取整個地圖含底圖
function exportMapImage() {
    if(!currentOverlay) {
         alert("請先生成成果"); return;
    }
    const mapElement = document.getElementById('map');
    
    // 隱藏不必要的控制項
    const controls = mapElement.querySelectorAll('.leaflet-control-container');
    controls.forEach(c => c.style.display = 'none');
    
    html2canvas(mapElement, {
        useCORS: true, // 允許抓取 OSM 底圖
        allowTaint: false,
        backgroundColor: null
    }).then(canvas => {
        // 恢復控制項
        controls.forEach(c => c.style.display = '');
        
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'gis_map_export.png';
        a.click();
    }).catch(err => {
        // 恢復控制項如果出錯
        controls.forEach(c => c.style.display = '');
        alert("截圖失敗: \n" + err.message);
        console.error(err);
    });
}

// AI 分析
async function startAIAnalysis() {
    const key = document.getElementById('api-key').value.trim();
    if(!key) {
        alert("請先輸入 Gemini API Key"); return;
    }
    if(!rawAnalysisData || !rawAnalysisData.min_v) {
        alert("請先完成一次圖表生成"); return;
    }

    const btn = document.getElementById('ai-btn');
    btn.innerText = "思考中...";
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/gis/ai-analyze', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                api_key: key,
                data: rawAnalysisData
            })
        });
        
        if(!res.ok) throw new Error(await res.text());
        const result = await res.json();
        
        document.getElementById('ai-report-content').innerHTML = marked.parse(result.report);
        document.getElementById('ai-report-container').style.display = 'flex';
        
    } catch(err) {
        alert(`AI 分析失敗:\n${err.message}`);
    } finally {
        btn.innerText = "🧠 執行 AI 分析";
        btn.disabled = false;
    }
}

function closeAiReport() {
    document.getElementById('ai-report-container').style.display = 'none';
}

// ==========================================
// 專案管理邏輯
// ==========================================

async function loadProjects() {
    const listContainer = document.getElementById('project-list');
    if (!listContainer) return;

    try {
        // 1. 顯示連線中狀態
        listContainer.innerHTML = '<p class="project-empty" style="color:var(--accent-cyan); padding: 10px;">📡 正在載入專案...</p>';
        
        // 2. 使用快取清除 (Cache Buster)
        const timestamp = new Date().getTime();
        const res = await fetch(`/api/gis/projects?t=${timestamp}`);
        
        if (!res.ok) throw new Error(`伺服器回應錯誤 (${res.status})`);
        
        const projects = await res.json();
        console.log(`[Diagnostic] 獲取到 ${projects.length} 個專案:`, projects);

        // 3. 處理空資料情況
        if (!Array.isArray(projects) || projects.length === 0) {
            listContainer.innerHTML = '<p class="project-empty" style="padding: 10px;">🗄️ 尚未儲存任何專案</p>';
            return;
        }

        // 4. 成功渲染，加入更詳盡的 fallback 與錯誤捕捉
        const html = projects.map(p => {
            try {
                const name = p.name || "未命名專案";
                // 更加穩健的日期處理
                let timeStr = "未知日期";
                if (p.timestamp) {
                    // 支援 "YYYY-MM-DD HH:MM:SS" 或 ISO 格式
                    timeStr = p.timestamp.includes(' ') ? p.timestamp.split(' ')[0] : p.timestamp.split('T')[0];
                }
                const isPinned = p.is_pinned ? "📌" : "";
                const activeClass = (p.id === currentProjectId) ? 'active' : '';
                
                return `
                <div class="project-item ${activeClass}" onclick="openProject('${p.id}')">
                    <div class="project-info">
                        <h5>${name}</h5>
                        <div class="project-meta">
                            <span>📅 ${timeStr}</span>
                            <span>${isPinned}</span>
                        </div>
                    </div>
                    <div class="project-actions">
                        <button class="btn-mini" onclick="event.stopPropagation(); togglePinProject('${p.id}')" title="釘選">📌</button>
                        <button class="btn-mini" onclick="event.stopPropagation(); deleteProject('${p.id}')" title="刪除">🗑️</button>
                    </div>
                </div>
                `;
            } catch (e) {
                console.error("渲染單個專案失敗:", e, p);
                return ""; // 略過錯誤的項目
            }
        }).join('');

        listContainer.innerHTML = html || '<p class="project-empty">⚠️ 專案列表顯示異常</p>';

    } catch (err) {
        console.error("載入專案列表失敗:", err);
        listContainer.innerHTML = `<p class="project-empty" style="color:var(--danger); padding: 10px;">載入失敗: ${err.message}</p>`;
    }
}

async function saveCurrentProject() {
    const name = document.getElementById('project-name').value.trim();
    if (!name) {
        alert("請輸入專案儲存名稱");
        return;
    }

    if (parsedData.length === 0) {
        alert("沒有資料可以儲存");
        return;
    }

    const projectId = currentProjectId || crypto.randomUUID();
    const config = {
        method: document.getElementById('config-method').value,
        step: document.getElementById('config-step').value,
        cmap: document.getElementById('config-cmap').value,
        alpha: document.getElementById('config-alpha').value,
        linewidth: document.getElementById('config-linewidth').value,
        smooth: document.getElementById('config-smooth').checked,
        pollutant: document.getElementById('pollutant-type').value,
        show_fill: document.getElementById('config-show-fill').checked,
        line_color: document.getElementById('config-linecolor').value,
        show_label: document.getElementById('config-show-label').checked,
        label_size: document.getElementById('config-labelsize').value,
        line_style: document.getElementById('config-linestyle').value,
        title: document.getElementById('config-title').value,
        col_x: document.getElementById('col-x').value,
        col_y: document.getElementById('col-y').value,
        col_v: document.getElementById('col-v').value
    };

    try {
        const res = await fetch('/api/gis/projects', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                id: projectId,
                name: name,
                data_points: parsedData,
                config: config
            })
        });

        if (res.ok) {
            currentProjectId = projectId;
            alert("專案儲存成功");
            loadProjects();
        } else {
            throw new Error(await res.text());
        }
    } catch (err) {
        alert("儲存專案失敗: " + err.message);
    }
}

async function openProject(id) {
    try {
        const res = await fetch(`/api/gis/projects/${id}`);
        if (!res.ok) throw new Error("找不到專案資料");
        const p = await res.json();
        
        currentProjectId = p.id;
        document.getElementById('project-name').value = p.name;
        
        // 還原資料
        parsedData = p.data_points;
        const cfg = p.config;
        
        // 還原設定
        document.getElementById('config-method').value = cfg.method;
        document.getElementById('config-step').value = cfg.step;
        document.getElementById('config-cmap').value = cfg.cmap;
        document.getElementById('config-alpha').value = cfg.alpha;
        document.getElementById('alpha-val').innerText = cfg.alpha;
        document.getElementById('config-linewidth').value = cfg.linewidth;
        document.getElementById('lw-val').innerText = cfg.linewidth;
        document.getElementById('config-smooth').checked = cfg.smooth;
        document.getElementById('pollutant-type').value = cfg.pollutant;
        document.getElementById('config-show-fill').checked = cfg.show_fill;
        document.getElementById('config-linecolor').value = cfg.line_color;
        document.getElementById('config-show-label').checked = cfg.show_label;
        document.getElementById('config-labelsize').value = cfg.label_size;
        document.getElementById('config-linestyle').value = cfg.line_style;
        document.getElementById('config-title').value = cfg.title || '';
        
        // 初始化對應欄位 (因為資料已解析)
        setupMapping(parsedData, `專案: ${p.name}`);
        // 強制還原特定的 select 內容
        if(cfg.col_x) document.getElementById('col-x').value = cfg.col_x;
        if(cfg.col_y) document.getElementById('col-y').value = cfg.col_y;
        if(cfg.col_v) document.getElementById('col-v').value = cfg.col_v;

        renderDataMarkers();
        loadProjects(); // 更新選中狀態
    } catch (err) {
        alert("開啟專案失敗: " + err.message);
    }
}

async function deleteProject(id) {
    if (!confirm("確定要刪除此專案嗎？")) return;
    try {
        const res = await fetch(`/api/gis/projects/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (currentProjectId === id) currentProjectId = null;
            loadProjects();
        } else {
            alert(await res.text());
        }
    } catch (err) {
        alert("刪除失敗");
    }
}

async function togglePinProject(id) {
    try {
        await fetch(`/api/gis/projects/${id}/pin`, { method: 'POST' });
        loadProjects();
    } catch (err) {}
}

// 頁面載入初始化
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
});

// ==========================================
// 匯出輔助函式
// ==========================================

/**
 * WGS84 (lon, lat) → TWD97 TM2 (x, y) 正向投影
 */
function wgs84ToTwd97(lon, lat) {
    const a   = 6378137.0;
    const b   = 6356752.314245;
    const lon0 = 121 * Math.PI / 180;
    const k0  = 0.9999;
    const dx  = 250000;
    const e2  = 1 - (b * b) / (a * a);
    const lonR = lon * Math.PI / 180;
    const latR = lat * Math.PI / 180;

    const N = a / Math.sqrt(1 - e2 * Math.pow(Math.sin(latR), 2));
    const T = Math.pow(Math.tan(latR), 2);
    const C = (e2 / (1 - e2)) * Math.pow(Math.cos(latR), 2);
    const A = Math.cos(latR) * (lonR - lon0);
    const M = a * (
        (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256) * latR
        - (3*e2/8 + 3*e2*e2/32 + 45*e2*e2*e2/1024) * Math.sin(2 * latR)
        + (15*e2*e2/256 + 45*e2*e2*e2/1024) * Math.sin(4 * latR)
        - (35*e2*e2*e2/3072) * Math.sin(6 * latR)
    );
    const x = dx + k0 * N * (
        A + (1 - T + C) * Math.pow(A, 3) / 6
        + (5 - 18*T + T*T + 72*C - 58*(e2/(1-e2))) * Math.pow(A, 5) / 120
    );
    const y = k0 * (
        M + N * Math.tan(latR) * (
            Math.pow(A, 2) / 2
            + (5 - T + 9*C + 4*C*C) * Math.pow(A, 4) / 24
            + (61 - 58*T + T*T + 600*C - 330*(e2/(1-e2))) * Math.pow(A, 6) / 720
        )
    );
    return { x, y };
}

/**
 * 計算合適的刻度間距 (1/2/5/10 冪次取整)
 */
function niceStep(range, n = 7) {
    const raw = range / n;
    if (raw <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const s of [1, 2, 5, 10]) {
        if (raw <= s * mag) return s * mag;
    }
    return 10 * mag;
}

/**
 * 在 Canvas 上繪製 GIS 風格指北針
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx  圓心 X
 * @param {number} cy  圓心 Y
 * @param {number} r   半徑
 */
function drawNorthArrowCanvas(ctx, cx, cy, r = 26) {
    // 白底外圈
    ctx.beginPath();
    ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 北方槳葉 (深藍)
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r * 0.38, cy + r * 0.05);
    ctx.lineTo(cx, cy - r * 0.08);
    ctx.closePath();
    ctx.fillStyle = '#1a3a6b';
    ctx.fill();
    ctx.strokeStyle = '#0d2040';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // 南方槳葉 (金黃)
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    ctx.lineTo(cx + r * 0.38, cy - r * 0.05);
    ctx.lineTo(cx, cy - r * 0.08);
    ctx.closePath();
    ctx.fillStyle = '#e8a820';
    ctx.fill();
    ctx.strokeStyle = '#b07810';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // N 文字
    ctx.fillStyle = '#1a3a6b';
    ctx.font = `bold ${Math.round(r * 0.72)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('N', cx, cy - r - 2);
    ctx.textBaseline = 'alphabetic';
}
