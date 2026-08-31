/**
 * 污染來源追蹤系統 — 前端互動邏輯 (地圖式)
 */
(function () {
    'use strict';

    // ===== 全域狀態 =====
    const STATE = {
        csvData: null,
        sessionId: null,
        dirCol: '', speedCol: '', concCol: '', timeCol: '',
        stationLat: null, stationLng: null,
        durationHours: 1,
        trajectories: null,
        events: null,
        heatmapData: null,
        playTimer: null, currentFrame: 0,
        map: null,
        stationMarker: null,
        trajLayer: null, // 軌跡線圖層群組
        heatLayer: null, // 熱力圖層
        radiusLayer: null, // 動態影響圓圖層
        fixedRadiusLayer: null, // 固定搜尋半徑圖層
    };

    // ===== DOM 快取 =====
    const $ = id => document.getElementById(id);
    const csvInput = $('csvInput');
    const dropZone = $('dropZone');
    const mappingSection = $('mappingSection');
    const timeColSel = $('timeColSel');
    const dirColSel = $('dirColSel');
    const speedColSel = $('speedColSel');
    const concColSel = $('concColSel');
    const stationX = $('stationX');
    const stationY = $('stationY');
    const setStationBtn = $('setStationBtn');
    const pickMapMode = $('pickMapMode');
    const startAnalysisBtn = $('startAnalysisBtn');
    const playerBar = $('playerBar');
    const playBtn = $('playBtn');
    const pauseBtn = $('pauseBtn');
    const stopBtn = $('stopBtn');
    const timeSlider = $('timeSlider');
    const sliderLabel = $('sliderLabel');
    const frameInfo = $('frameInfo');
    const aiBtn = $('aiBtn');
    const eventList = $('eventList');

    // ===== Toast 通知 =====
    function showToast(msg, type = 'success') {
        const c = $('toastContainer');
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ===== API Helper =====
    async function api(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(err.detail || '請求失敗');
        }
        return res.json();
    }

    function getCommonBody() {
        return {
            csv_data: STATE.csvData,
            dir_col: STATE.dirCol,
            speed_col: STATE.speedCol,
            conc_col: STATE.concCol,
            time_col: STATE.timeCol,
            station_lat: STATE.stationLat,
            station_lng: STATE.stationLng,
            duration_hours: STATE.durationHours
        };
    }

    // ===== 地圖初始化 =====
    function initMap() {
        STATE.map = L.map('map', {
            zoomControl: false, // 隱藏預設，自行放置
            preferCanvas: true  // 啟用 Canvas 渲染，確保截圖完整捕捉虛線
        }).setView([23.5, 121], 7);
        
        L.control.zoom({ position: 'topright' }).addTo(STATE.map);

        // 底圖定義
        STATE.basemaps = {
            osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
            satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri' }),
            dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap &copy; CartoDB' })
        };
        
        STATE.currentBasemap = STATE.basemaps.dark;
        STATE.currentBasemap.addTo(STATE.map);

        const basemapSelect = document.getElementById('basemap-select');
        if (basemapSelect) {
            basemapSelect.addEventListener('change', (e) => {
                STATE.map.removeLayer(STATE.currentBasemap);
                STATE.currentBasemap = STATE.basemaps[e.target.value];
                STATE.currentBasemap.addTo(STATE.map);
            });
        }

        STATE.trajLayer = L.layerGroup().addTo(STATE.map);
        STATE.radiusLayer = L.layerGroup().addTo(STATE.map);
        STATE.fixedRadiusLayer = L.layerGroup().addTo(STATE.map);

        // 指北針
        const northArrowControl = L.control({position: 'topleft'});
        northArrowControl.onAdd = function (map) {
            let div = L.DomUtil.create('div', 'north-arrow-control');
            div.innerHTML = '<span>🧭</span>';
            div.title = "指北針";
            return div;
        };
        if ($('showNorth').checked) northArrowControl.addTo(STATE.map);
        $('showNorth').addEventListener('change', (e) => {
            if (e.target.checked) northArrowControl.addTo(STATE.map);
            else STATE.map.removeLayer(northArrowControl);
        });

        // 地圖點擊事件 (用於設定監測站)
        STATE.map.on('click', (e) => {
            if (pickMapMode.checked) {
                STATE.stationLat = e.latlng.lat;
                STATE.stationLng = e.latlng.lng;
                updateStationMarker();
                stationX.value = STATE.stationLng.toFixed(5);
                stationY.value = STATE.stationLat.toFixed(5);
                pickMapMode.checked = false; // 點擊一次後自動取消勾選
                showToast(`已設定監測站位置: ${STATE.stationLng.toFixed(4)}, ${STATE.stationLat.toFixed(4)}`);
                checkReady();
            }
        });
    }

    function updateStationMarker() {
        if (!STATE.stationLat || !STATE.stationLng) return;
        if (STATE.stationMarker) {
            STATE.map.removeLayer(STATE.stationMarker);
        }
        STATE.stationMarker = L.marker([STATE.stationLat, STATE.stationLng], {
            title: '監測站',
            draggable: true
        }).addTo(STATE.map);

        STATE.stationMarker.bindTooltip('🏭 監測站', { permanent: true, direction: 'top', className: 'station-tooltip' });

        STATE.stationMarker.on('dragend', (e) => {
            const pos = e.target.getLatLng();
            STATE.stationLat = pos.lat;
            STATE.stationLng = pos.lng;
            stationX.value = STATE.stationLng.toFixed(5);
            stationY.value = STATE.stationLat.toFixed(5);
            checkReady();
        });

        STATE.map.setView([STATE.stationLat, STATE.stationLng], 12);
        renderFixedRadius(); // 更新站位後重繪固定圓
    }

    // ===== 固定搜尋半徑 =====
    function renderFixedRadius() {
        if (!STATE.fixedRadiusLayer) return;
        STATE.fixedRadiusLayer.clearLayers();

        const isVisible = $('showFixedRadius').checked;
        const radiusKm = parseFloat($('fixedRadiusKm').value);

        if (isVisible && !isNaN(radiusKm) && STATE.stationLat && STATE.stationLng) {
            const circle = L.circle([STATE.stationLat, STATE.stationLng], {
                radius: radiusKm * 1000,
                color: '#ff8c42', // 橘色區分動態圓
                weight: 2,
                fillColor: 'rgba(255, 140, 66, 0.1)',
                fillOpacity: 0.2,
                dashArray: '10, 10',
                interactive: true
            }).addTo(STATE.fixedRadiusLayer);

            circle.bindTooltip(`搜尋範圍: ${radiusKm} km`, {
                permanent: true,
                direction: 'center',
                className: 'fixed-radius-tooltip'
            });
        }
    }

    $('showFixedRadius').addEventListener('change', renderFixedRadius);
    $('fixedRadiusKm').addEventListener('input', renderFixedRadius);

    // 監測站手動輸入
    setStationBtn.addEventListener('click', async () => {
        let x = parseFloat(stationX.value);
        let y = parseFloat(stationY.value);
        if (isNaN(x) || isNaN(y)) {
            showToast('請輸入有效的座標', 'error'); return;
        }
        setStationBtn.disabled = true;
        setStationBtn.textContent = '處理中...';
        try {
            // 判斷是否為 TWD97 (X > 100000)
            if (x > 100000 && y > 1000000) {
                const res = await api('/api/pollution-tracker/twd97-convert', { x: x, y: y });
                STATE.stationLat = res.lat;
                STATE.stationLng = res.lng;
                showToast(`已將 TWD97 轉換為 WGS84: ${STATE.stationLng.toFixed(5)}, ${STATE.stationLat.toFixed(5)}`);
            } else {
                STATE.stationLng = x; // 假設 x 是經度
                STATE.stationLat = y; // 假設 y 是緯度
                showToast('已更新經緯度');
            }
            updateStationMarker();
            checkReady();
        } catch (e) {
            showToast('座標轉換失敗: ' + e.message, 'error');
        } finally {
            setStationBtn.disabled = false;
            setStationBtn.textContent = '更新監測站位置';
        }
    });

    // ===== 檔案上傳 =====
    function handleFile(file) {
        if (!file || !file.name.toLowerCase().endsWith('.csv')) {
            showToast('請上傳 CSV 檔案', 'error'); return;
        }
        const fd = new FormData();
        fd.append('file', file);
        fetch('/api/pollution-tracker/upload-csv', { method: 'POST', body: fd })
            .then(r => r.json())
            .then(data => {
                if (!data.ok) throw new Error('上傳失敗');
                STATE.csvData = data.csv_text;
                STATE.sessionId = data.session_id;
                const info = data.info;
                populateSelects(info.columns, info.time_col);
                mappingSection.style.display = 'block';
                dropZone.querySelector('p').textContent = `📄 ${file.name} (已載入 ${info.rows} 筆)`;
                showToast(`資料載入成功，請確認欄位並設定監測站`);
                checkReady();
            })
            .catch(e => showToast(e.message, 'error'));
    }

    csvInput.addEventListener('change', e => {
        if (e.target.files[0]) {
            handleFile(e.target.files[0]);
            e.target.value = '';
        }
    });

    dropZone.addEventListener('click', (e) => {
        if (e.target !== csvInput) csvInput.click();
    });
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    function populateSelects(columns, detectedTimeCol) {
        [timeColSel, dirColSel, speedColSel, concColSel].forEach(sel => {
            sel.innerHTML = '<option value="">-- 選擇 --</option>';
            columns.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c; opt.textContent = c;
                sel.appendChild(opt);
            });
        });
        if (detectedTimeCol) timeColSel.value = detectedTimeCol;
        const dirKw = ['wd', 'dir', '風向', 'wind_dir'];
        const spdKw = ['ws', 'speed', '風速', 'wind_speed'];
        const concKw = ['conc', 'pollut', '濃度', 'pm', 'so2'];
        columns.forEach(c => {
            const cl = c.toLowerCase();
            if (!dirColSel.value && dirKw.some(k => cl.includes(k))) dirColSel.value = c;
            if (!speedColSel.value && spdKw.some(k => cl.includes(k))) speedColSel.value = c;
            if (!concColSel.value && concKw.some(k => cl.includes(k))) concColSel.value = c;
        });
    }

    function checkReady() {
        if (STATE.csvData && STATE.stationLat && STATE.stationLng) {
            startAnalysisBtn.disabled = false;
        } else {
            startAnalysisBtn.disabled = true;
        }
    }

    [timeColSel, dirColSel, speedColSel, concColSel].forEach(s => s.addEventListener('change', checkReady));

    // ===== 開始分析 =====
    startAnalysisBtn.addEventListener('click', async () => {
        STATE.dirCol = dirColSel.value;
        STATE.speedCol = speedColSel.value;
        STATE.concCol = concColSel.value;
        STATE.timeCol = timeColSel.value;
        STATE.durationHours = parseFloat($('durationHours').value) || 1.0;

        if (!STATE.dirCol || !STATE.speedCol || !STATE.concCol || !STATE.timeCol) {
            showToast('請完成所有欄位對應', 'error'); return;
        }

        startAnalysisBtn.disabled = true;
        startAnalysisBtn.textContent = '⏳ 分析中...';

        try {
            await Promise.all([loadTrajectories(), loadHeatmap(), loadEvents()]);
            
            playerBar.style.display = 'flex';
            aiBtn.disabled = false;
            
            // 初始化播放器
            if (STATE.trajectories && STATE.trajectories.total > 0) {
                timeSlider.max = STATE.trajectories.total - 1;
                renderFrame(0);
                // 調整視角
                const group = new L.featureGroup([STATE.stationMarker]);
                STATE.map.fitBounds(group.getBounds().pad(2.0));
            }
            
            // 顯示地圖標題
            const titleBox = $('map-title-box');
            if (titleBox) {
                titleBox.style.display = 'block';
                titleBox.textContent = `污染來源動態追蹤`;
            }
            
            showToast('分析完成！可以開始播放軌跡');
        } catch (e) {
            showToast('分析失敗: ' + e.message, 'error');
            console.error(e);
        } finally {
            startAnalysisBtn.disabled = false;
            startAnalysisBtn.textContent = '⚡ 執行分析';
        }
    });

    // ===== 載入軌跡 =====
    async function loadTrajectories() {
        const body = getCommonBody();
        const res = await api('/api/pollution-tracker/trajectories', body);
        STATE.trajectories = res.data;
    }

    // ===== 載入熱度圖 =====
    async function loadHeatmap() {
        const body = getCommonBody();
        const res = await api('/api/pollution-tracker/heatmap', body);
        STATE.heatmapData = res.data;
        renderHeatmap();
    }

    function renderHeatmap() {
        if (STATE.heatLayer) {
            STATE.map.removeLayer(STATE.heatLayer);
            STATE.heatLayer = null;
        }
        if (!$('showHeatmap').checked || !STATE.heatmapData || STATE.heatmapData.total === 0) return;

        // Leaflet.heat 預期格式: [lat, lng, intensity]
        // 放大強度讓熱區更明顯
        const points = STATE.heatmapData.points.map(p => [p[0], p[1], p[2] * 2]);
        
        STATE.heatLayer = L.heatLayer(points, {
            radius: 25,
            blur: 15,
            maxZoom: 12,
            max: 1.0,
            gradient: {0.2: 'blue', 0.4: 'cyan', 0.6: 'lime', 0.8: 'yellow', 1.0: 'red'}
        }).addTo(STATE.map);

        // 更新圖例
        const legendBox = $('map-legend-box');
        if (legendBox) {
            legendBox.style.display = 'block';
            legendBox.innerHTML = `
                <div class="legend-title">熱度分佈 (發生頻率)</div>
                <div class="legend-gradient-container">
                    <div class="legend-gradient" style="background: linear-gradient(to top, blue 0%, cyan 40%, lime 60%, yellow 80%, red 100%);"></div>
                    <div class="legend-labels">
                        <span>高頻 (100%)</span>
                        <span>中高頻</span>
                        <span>中頻</span>
                        <span>中低頻</span>
                        <span>低頻 (0%)</span>
                    </div>
                </div>
            `;
        }
    }

    $('showHeatmap').addEventListener('change', renderHeatmap);

    // ===== 高污染事件 =====
    async function loadEvents() {
        const body = getCommonBody();
        body.threshold_percentile = 95;
        const res = await api('/api/pollution-tracker/detect-events', body);
        STATE.events = res.data;
        renderEvents(res.data);
    }

    function renderEvents(data) {
        $('eventCount').textContent = data.total_events;
        if (!data.events || data.events.length === 0) {
            eventList.innerHTML = '<div class="chart-placeholder-mini"><p>未偵測到高污染事件</p></div>';
            return;
        }
        eventList.innerHTML = data.events.map((evt, i) => `
            <div class="event-card ${evt.severity}" onclick="window._focusEvent(${i})">
                <div class="event-time">
                    ${evt.start.substring(0, 16).replace('T', ' ')} ~ ${evt.end.substring(11, 16)}
                </div>
                <div class="event-info">
                    <span class="event-conc">▲ ${evt.max_concentration}</span>
                    <span>主風向 ${evt.main_direction}°</span>
                </div>
            </div>
        `).join('');
    }

    window._focusEvent = (idx) => {
        if (!STATE.events || !STATE.events.events[idx] || !STATE.trajectories) return;
        const evt = STATE.events.events[idx];
        // 找到對應時間的 frame
        const frameIdx = STATE.trajectories.trajectories.findIndex(t => t.time >= evt.start);
        if (frameIdx >= 0) {
            STATE.currentFrame = frameIdx;
            renderFrame(frameIdx);
        }
    };

    // ===== 動畫播放 =====
    function renderFrame(idx) {
        if (!STATE.trajectories || !STATE.trajectories.trajectories[idx]) return;
        const frame = STATE.trajectories.trajectories[idx];
        
        timeSlider.value = idx;
        const timeStr = frame.time.substring(0, 16).replace('T', ' ');
        sliderLabel.textContent = `🕒 ${timeStr} | 濃度: ${frame.concentration}`;
        frameInfo.textContent = `${idx + 1} / ${STATE.trajectories.total}`;

        STATE.trajLayer.clearLayers();
        STATE.radiusLayer.clearLayers();

        // 畫軌跡線 (藍色箭頭線)
        if ($('showTrajectories').checked) {
            const latlngs = [
                [STATE.stationLat, STATE.stationLng],
                [frame.endpoint_lat, frame.endpoint_lng]
            ];
            const polyline = L.polyline(latlngs, {
                color: '#00d2ff',
                weight: 3,
                opacity: 0.8,
                dashArray: '5, 5'
            }).addTo(STATE.trajLayer);
            
            // 軌跡終點標記
            L.circleMarker([frame.endpoint_lat, frame.endpoint_lng], {
                radius: 4, fillColor: '#00d2ff', color: '#fff', weight: 1, fillOpacity: 1
            }).bindTooltip(`來源推測<br>距離: ${frame.distance_km} km<br>風速: ${frame.wind_speed} m/s`, {direction:'top'}).addTo(STATE.trajLayer);
        }

        // 畫擴散影響圓
        if ($('showRadius').checked && frame.distance_km > 0) {
            const circle = L.circle([STATE.stationLat, STATE.stationLng], {
                radius: frame.distance_km * 1000, // 轉為公尺
                color: 'rgba(255,255,255,0.6)',
                weight: 1.5,
                fillColor: 'transparent',
                dashArray: '8, 8',
                interactive: true
            }).addTo(STATE.radiusLayer);

            // 顯示半徑距離標籤
            circle.bindTooltip(`${frame.distance_km.toFixed(1)} km`, {
                permanent: true,
                direction: 'center',
                className: 'radius-tooltip',
                opacity: 0.9
            });
        }
    }

    $('showTrajectories').addEventListener('change', () => renderFrame(STATE.currentFrame));
    $('showRadius').addEventListener('change', () => renderFrame(STATE.currentFrame));

    playBtn.addEventListener('click', () => {
        if (!STATE.trajectories || STATE.trajectories.total < 2) return;
        playBtn.style.display = 'none';
        pauseBtn.style.display = 'inline-flex';
        const speed = parseInt($('playSpeedSel').value);
        STATE.playTimer = setInterval(() => {
            STATE.currentFrame++;
            if (STATE.currentFrame >= STATE.trajectories.total) {
                STATE.currentFrame = 0;
            }
            renderFrame(STATE.currentFrame);
        }, speed);
    });

    pauseBtn.addEventListener('click', () => {
        clearInterval(STATE.playTimer);
        pauseBtn.style.display = 'none';
        playBtn.style.display = 'inline-flex';
    });

    stopBtn.addEventListener('click', () => {
        clearInterval(STATE.playTimer);
        pauseBtn.style.display = 'none';
        playBtn.style.display = 'inline-flex';
        STATE.currentFrame = 0;
        renderFrame(0);
    });

    timeSlider.addEventListener('input', () => {
        STATE.currentFrame = parseInt(timeSlider.value);
        renderFrame(STATE.currentFrame);
    });

    // ===== AI 分析 =====
    aiBtn.addEventListener('click', async () => {
        const apiKey = $('apiKeyInput').value.trim();
        if (!apiKey) { showToast('請先輸入 Gemini API Key', 'error'); return; }
        aiBtn.disabled = true;
        aiBtn.textContent = '🧠 分析中...';
        try {
            const summaryData = {
                station: {lat: STATE.stationLat, lng: STATE.stationLng},
                duration_hours: STATE.durationHours,
                events: STATE.events,
                heatmap_summary: STATE.heatmapData ? {
                    total_points: STATE.heatmapData.total,
                    max_intensity: STATE.heatmapData.max_intensity
                } : null
            };
            const res = await fetch('/api/pollution-tracker/ai-analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: apiKey, data: summaryData }),
            });
            const json = await res.json();
            if (json.status === 'success') {
                showAiReport(json.report);
            } else {
                showToast('AI 分析失敗: ' + (json.detail || '未知錯誤'), 'error');
            }
        } catch (e) {
            showToast('AI 分析失敗: ' + e.message, 'error');
        } finally {
            aiBtn.disabled = false;
            aiBtn.textContent = '🧠 生成分析報告';
        }
    });

    function showAiReport(markdown) {
        const overlay = $('aiReportOverlay');
        const content = $('aiReportContent');
        content.innerHTML = typeof marked !== 'undefined' ? marked.parse(markdown) : markdown.replace(/\n/g, '<br>');
        overlay.style.display = 'flex';
    }

    window.closeAiReport = () => {
        $('aiReportOverlay').style.display = 'none';
    };

    // ===== 匯出功能 (比照 GIS) =====
    window.exportMapImage = async () => {
        const mapElement = $('map');
        const controls = mapElement.querySelectorAll('.leaflet-control-container');
        controls.forEach(c => c.style.display = 'none');
        
        try {
            const canvas = await html2canvas(mapElement, {
                useCORS: true,
                allowTaint: false,
                backgroundColor: null
            });
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = `Pollution_Tracker_${new Date().getTime()}.png`;
            a.click();
        } catch (err) {
            showToast("截圖失敗: " + err.message, 'error');
        } finally {
            controls.forEach(c => c.style.display = '');
        }
    };

    let lastExportedBase64 = "";
    window.exportProfessionalImage = async () => {
        const modal = $('export-modal');
        const previewImg = $('export-preview-img');
        previewImg.src = '';
        modal.style.display = 'flex';

        const hiddenEls = [];
        try {
            document.querySelectorAll('.leaflet-control-container').forEach(el => {
                el.style.visibility = 'hidden';
                hiddenEls.push(el);
            });

            const mapEl = $('map');
            const mapCanvas = await html2canvas(mapEl, {
                useCORS: true,
                allowTaint: false,
                backgroundColor: '#0f172a',
                scale: 1
            });

            hiddenEls.forEach(el => { el.style.visibility = ''; });

            const ML = 90, MT = 20, MR = 20, MB = 68;
            const W = mapCanvas.width;
            const H = mapCanvas.height;
            const outW = W + ML + MR;
            const outH = H + MT + MB;

            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = outW;
            finalCanvas.height = outH;
            const ctx = finalCanvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, outW, outH);
            ctx.drawImage(mapCanvas, ML, MT);
            ctx.strokeStyle = '#333333';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(ML, MT, W, H);

            // ── 精確計算座標軸邊界與轉換 ──
            // 使用 containerPointToLatLng 確保獲取的經緯度與 captured canvas 完全對應
            const topLeft = STATE.map.containerPointToLatLng([0, 0]);
            const bottomRight = STATE.map.containerPointToLatLng([W, H]);
            
            const twdTL = wgs84ToTwd97(topLeft.lng, topLeft.lat);
            const twdBR = wgs84ToTwd97(bottomRight.lng, bottomRight.lat);
            
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
            
            // ── X 軸刻度 ──
            for (let tx = Math.ceil(twdMinX / stepX) * stepX; tx <= twdMaxX; tx += stepX) {
                const wgs = twd97ToWgs84_local(tx, midTwdY);
                const pt = STATE.map.latLngToContainerPoint([wgs.lat, wgs.lon]);
                const px = ML + pt.x;
                
                if (pt.x < 0 || pt.x > W) continue;
                
                ctx.beginPath(); ctx.moveTo(px, MT + H); ctx.lineTo(px, MT + H + 6); ctx.stroke();
                ctx.save();
                ctx.translate(px + 2, MT + H + 10);
                ctx.rotate(Math.PI / 4);
                ctx.fillText(Math.round(tx), 0, 0);
                ctx.restore();
            }

            // ── Y 軸刻度 ──
            for (let ty = Math.ceil(twdMinY / stepY) * stepY; ty <= twdMaxY; ty += stepY) {
                const wgs = twd97ToWgs84_local(midTwdX, ty);
                const pt = STATE.map.latLngToContainerPoint([wgs.lat, wgs.lon]);
                const py = MT + pt.y;
                
                if (pt.y < 0 || pt.y > H) continue;
                
                ctx.beginPath(); ctx.moveTo(ML, py); ctx.lineTo(ML - 6, py); ctx.stroke();
                ctx.textAlign = 'right';
                ctx.fillText(Math.round(ty), ML - 8, py + 4);
            }

            if ($('showNorth').checked) {
                drawNorthArrowCanvas(ctx, ML + W - 50, MT + 50, 20);
            }

            lastExportedBase64 = finalCanvas.toDataURL('image/png');
            previewImg.src = lastExportedBase64;
        } catch (err) {
            showToast("匯出失敗: " + err.message, 'error');
            window.closeExportModal();
        }
    };

    window.closeExportModal = () => { $('export-modal').style.display = 'none'; };
    window.downloadExportImage = () => {
        if (!lastExportedBase64) return;
        const a = document.createElement('a');
        a.href = lastExportedBase64;
        a.download = `Professional_Tracker_${new Date().getTime()}.png`;
        a.click();
    };

    function drawNorthArrowCanvas(ctx, x, y, r) {
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#ff4d4f'; ctx.beginPath(); ctx.moveTo(0, -r+5); ctx.lineTo(r/3, 0); ctx.lineTo(-r/3, 0); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, r-5); ctx.lineTo(r/3, 0); ctx.lineTo(-r/3, 0); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${r/1.5}px Arial`; ctx.textAlign = 'center'; ctx.fillText('N', 0, -r-5);
        ctx.restore();
    }

    function wgs84ToTwd97(lon, lat) {
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

    function twd97ToWgs84_local(x, y) {
        const a = 6378137.0, b = 6356752.314245;
        const lon0 = 121 * Math.PI / 180, k0 = 0.9999, dx = 250000;
        const e = Math.sqrt(1 - Math.pow(b / a, 2));
        x -= dx;
        const m = y / k0;
        const mu = m / (a * (1 - Math.pow(e, 2) / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256));
        const e1 = (1 - Math.sqrt(1 - Math.pow(e, 2))) / (1 + Math.sqrt(1 - Math.pow(e, 2)));
        const j1 = 3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32, j2 = 21 * Math.pow(e1, 2) / 16 - 55 * Math.pow(e1, 4) / 32, j3 = 151 * Math.pow(e1, 3) / 96;
        const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu) + j3 * Math.sin(6 * mu);
        const e2 = Math.pow(e, 2) / (1 - Math.pow(e, 2)), c1 = e2 * Math.pow(Math.cos(fp), 2), t1 = Math.pow(Math.tan(fp), 2);
        const r1 = a * (1 - Math.pow(e, 2)) / Math.pow(1 - Math.pow(e, 2) * Math.pow(Math.sin(fp), 2), 1.5);
        const n1 = a / Math.sqrt(1 - Math.pow(e, 2) * Math.pow(Math.sin(fp), 2));
        const d = x / (n1 * k0);
        const lat = (fp - n1 * Math.tan(fp) / r1 * (Math.pow(d, 2) / 2 - (5 + 3 * t1 + 10 * c1 - 4 * Math.pow(c1, 2) - 9 * e2) * Math.pow(d, 4) / 24)) * 180 / Math.PI;
        const lon = (lon0 + (d - (1 + 2 * t1 + c1) * Math.pow(d, 3) / 6 + (5 - 2 * c1 + 28 * t1 - 3 * Math.pow(c1, 2) + 8 * e2 + 24 * Math.pow(t1, 2)) * Math.pow(d, 5) / 120) / Math.cos(fp)) * 180 / Math.PI;
        return { lat, lon };
    }

    function niceStep(range) {
        const x = Math.pow(10, Math.floor(Math.log10(range / 5)));
        const f = range / 5 / x;
        if (f < 1.5) return x;
        if (f < 3) return 2 * x;
        if (f < 7) return 5 * x;
        return 10 * x;
    }

    // ===== 啟動 =====
    document.addEventListener('DOMContentLoaded', initMap);

})();
