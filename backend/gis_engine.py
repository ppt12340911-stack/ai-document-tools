import io
import base64
import json
import numpy as np
import math
from typing import List, Dict, Any, Tuple
import matplotlib
matplotlib.use('Agg')  # 無介面模式
import matplotlib.pyplot as plt
from scipy.interpolate import griddata
import geojson
from geojson import Feature, FeatureCollection, MultiLineString

# 嘗試載入 PyKrige (Kriging 插值使用)
try:
    from pykrige.ok import OrdinaryKriging
    has_pykrige = True
except ImportError:
    has_pykrige = False
    print("Warning: PyKrige not installed. Kriging interpolation will fall back to IDW.")


# TWD97 與 WGS84 轉換
def twd97_to_wgs84(x: float, y: float) -> Tuple[float, float]:
    """精確轉換 TWD97 -> WGS84"""
    try:
        from pyproj import Transformer
        transformer = Transformer.from_crs("epsg:3826", "epsg:4326", always_xy=True)
        lon, lat = transformer.transform(x, y)
        return lon, lat
    except ImportError:
        # 簡易近似 (僅作備援)
        lon = (x - 250000) / 111000 + 121
        lat = y / 111000
        return lon, lat

def wgs84_to_twd97(lon: float, lat: float) -> Tuple[float, float]:
    """精確轉換 WGS84 -> TWD97"""
    try:
        from pyproj import Transformer
        transformer = Transformer.from_crs("epsg:4326", "epsg:3826", always_xy=True)
        x, y = transformer.transform(lon, lat)
        return x, y
    except ImportError:
        # 簡易近似 (僅作備援)
        x = (lon - 121) * 111000 + 250000
        y = lat * 111000
        return x, y


def _nice_step(range_val: float, n: int = 8) -> float:
    """計算合適的刻度間距 (向上取整到 1/2/5/10 的冪次)"""
    raw = range_val / n
    if raw <= 0:
        return 1.0
    magnitude = 10 ** math.floor(math.log10(raw))
    for s in [1, 2, 5, 10]:
        if raw <= s * magnitude:
            return float(s * magnitude)
    return float(10 * magnitude)


def _draw_north_arrow(ax) -> None:
    """在 axes 右上角繪製 GIS 風格指北針 (以 axes fraction 座標定位)"""
    import matplotlib.patches as mpatches
    cx, cy = 0.91, 0.87   # 圓心 (axes fraction)
    r  = 0.055            # 外圓半徑

    # 白底外圈
    outer = mpatches.Circle(
        (cx, cy), r + 0.013,
        transform=ax.transAxes, zorder=10,
        facecolor='white', edgecolor='#444444',
        linewidth=1.5, clip_on=False
    )
    ax.add_patch(outer)

    # 北方槳葉 (深藍)
    north = mpatches.FancyArrow(
        cx, cy, 0, r * 0.90,
        width=r * 0.36, head_width=r * 0.68, head_length=r * 0.52,
        transform=ax.transAxes, zorder=11,
        facecolor='#1a3a6b', edgecolor='#0d2040',
        length_includes_head=True, clip_on=False
    )
    ax.add_patch(north)

    # 南方槳葉 (金黃)
    south = mpatches.FancyArrow(
        cx, cy, 0, -r * 0.90,
        width=r * 0.36, head_width=r * 0.68, head_length=r * 0.52,
        transform=ax.transAxes, zorder=11,
        facecolor='#e8a820', edgecolor='#b07810',
        length_includes_head=True, clip_on=False
    )
    ax.add_patch(south)

    # "N" 文字
    ax.text(
        cx, cy + r + 0.030, 'N',
        transform=ax.transAxes, zorder=12,
        ha='center', va='bottom', fontsize=14,
        fontweight='bold', color='#1a3a6b', clip_on=False
    )


def process_coordinates(x_coords: List[float], y_coords: List[float]) -> Tuple[np.ndarray, np.ndarray]:
    """
    偵測是否為 TWD97，如果是則轉回 WGS84 (lon, lat)。
    """
    out_x = []
    out_y = []
    for x, y in zip(x_coords, y_coords):
        # 簡單判斷：若 X > 100000 且 Y > 1000000，通常是 TWD97 或類似的投影坐標系
        if x > 100000 and y > 1000000:
            lon, lat = twd97_to_wgs84(x, y)
            out_x.append(lon)
            out_y.append(lat)
        else:
            out_x.append(x)
            out_y.append(y)
    return np.array(out_x), np.array(out_y)


def generate_contour(
    data: List[Dict[str, float]], 
    method: str = "idw",
    levels_step: float = 10,
    colormap: str = "viridis",
    alpha: float = 0.5,
    linewidth: float = 1.0,
    smooth: bool = True,
    show_fill: bool = True,
    line_color: str = "#ff0000",
    show_label: bool = True,
    label_size: int = 12,
    line_style: str = "solid",
    export_mode: bool = False,
    show_north: bool = True
) -> Dict[str, Any]:
    """
    核心 API: 輸入點資料，輸出 base64 圖片 (Overlay用)、GeoJSON 及邊界資訊
    data 格式為 [{"x": 121.5, "y": 25.0, "value": 15}, ...]
    """
    if not data or len(data) < 4:
        raise ValueError("Data point count must be at least 4.")

    x_list = [d["x"] for d in data]
    y_list = [d["y"] for d in data]
    v_list = [d["value"] for d in data]

    # 1. 座標轉換
    px, py = process_coordinates(x_list, y_list)
    pv = np.array(v_list)

    # 2. 建立網格 (Grid)
    min_x, max_x = np.min(px), np.max(px)
    min_y, max_y = np.min(py), np.max(py)

    # 增加邊界緩衝，避免邊緣切斷
    pad_x = (max_x - min_x) * 0.1
    pad_y = (max_y - min_y) * 0.1
    if pad_x == 0: pad_x = 0.01
    if pad_y == 0: pad_y = 0.01
    # 生成擴展過且切分好的網格
    grid_x, grid_y = np.mgrid[min_x - pad_x:max_x + pad_x:400j, min_y - pad_y:max_y + pad_y:400j]

    grid_z = None
    if method == "kriging" and has_pykrige:
        try:
            # PyKrige 普通克里金
            OK = OrdinaryKriging(
                px, py, pv, 
                variogram_model='linear',
                verbose=False, 
                enable_plotting=False
            )
            z, _ = OK.execute('grid', grid_x[:,0], grid_y[0,:])
            grid_z = z.T
        except Exception as e:
            print(f"Kriging failed: {e}. Falling back to IDW.")
            method = "idw"
    
    if grid_z is None:
        # 實作真實的反距離加權 (Inverse Distance Weighting, IDW)
        # 避免 griddata(linear) 產生的多邊形銳角外插，也避免 RBF 的過度圓滑(牛眼效應)
        from scipy.spatial.distance import cdist
        pts = np.column_stack((px, py))
        grid_pts = np.column_stack((grid_x.ravel(), grid_y.ravel()))
        dist = cdist(grid_pts, pts)
        dist[dist < 1e-10] = 1e-10
        weights = 1.0 / (dist ** 2)
        grid_z_flat = np.sum(weights * pv, axis=1) / np.sum(weights, axis=1)
        grid_z = grid_z_flat.reshape(grid_x.shape)

    # 平滑處理 (保留極輕微平滑以消除鋸齒，移除之前的 sigma=3.0)
    if smooth:
        try:
            from scipy.ndimage import gaussian_filter
            grid_z = gaussian_filter(grid_z, sigma=0.5)
        except:
            pass

    # 4. 制訂等級 (Levels)
    min_v, max_v = np.min(grid_z), np.max(grid_z)
    try:
        levels_step = float(levels_step)
        if levels_step <= 0: levels_step = (max_v - min_v) / 10
    except:
        levels_step = (max_v - min_v) / 10

    if max_v <= min_v or levels_step == 0:
        levels = 10
    else:
        # 計算等高線區間
        start_level = math.floor(min_v / levels_step) * levels_step
        end_level = math.ceil(max_v / levels_step) * levels_step
        levels = np.arange(start_level, end_level + levels_step, levels_step)
        if len(levels) < 2:
            levels = 10 

    # 5. 產生 Matplotlib 圖形，並存為 Base64 (PNG 供 Leaflet ImageOverlay 使用)
    # 計算真實的寬高比，保持 matplotlib 輸出的影像比例正確，避免座標偏移
    aspect_ratio = (max_x + pad_x - (min_x - pad_x)) / (max_y + pad_y - (min_y - pad_y))

    if not export_mode:
        # 【互動模式】使用 add_axes([0, 0, 1, 1]) 強制圖形填滿邊界，徹底排除任何內建 Margin 導致的 Leaflet 座標偏移
        fig_w = 8
        fig_h = 8 / aspect_ratio
        fig = plt.figure(figsize=(fig_w, fig_h), dpi=150)
        ax = fig.add_axes([0, 0, 1, 1], frameon=False)
        ax.set_axis_off()
    else:
        # 【匯出模式】包含 TWD97 座標軸、精確刻度格線與 GIS 指北針
        fig_w = 10
        fig_h = max(8, 10 / aspect_ratio)
        fig = plt.figure(figsize=(fig_w, fig_h), dpi=150)
        ax = fig.add_subplot(111)

        # ── 字型設定 ──
        plt.rcParams['font.family'] = ['Microsoft JhengHei', 'SimHei', 'DejaVu Sans']
        ax.set_title("GIS 等值線分析圖", fontsize=14, pad=15, fontweight='bold')

        # ── 計算 TWD97 邊界，精確產生刻度位置 ──
        x_lo_t, _ = wgs84_to_twd97(min_x - pad_x, (min_y + max_y) / 2)
        x_hi_t, _ = wgs84_to_twd97(max_x + pad_x, (min_y + max_y) / 2)
        _, y_lo_t = wgs84_to_twd97((min_x + max_x) / 2, min_y - pad_y)
        _, y_hi_t = wgs84_to_twd97((min_x + max_x) / 2, max_y + pad_y)
        cx_t = (x_lo_t + x_hi_t) / 2
        cy_t = (y_lo_t + y_hi_t) / 2

        step_x = _nice_step(x_hi_t - x_lo_t)
        step_y = _nice_step(y_hi_t - y_lo_t)

        ticks_x_t = np.arange(
            math.ceil(x_lo_t  / step_x) * step_x,
            math.floor(x_hi_t / step_x) * step_x + step_x,
            step_x
        )
        ticks_y_t = np.arange(
            math.ceil(y_lo_t  / step_y) * step_y,
            math.floor(y_hi_t / step_y) * step_y + step_y,
            step_y
        )

        # 將 TWD97 刻度轉回 WGS84 (matplotlib 軸座標)
        ticks_x_wgs = [twd97_to_wgs84(t, cy_t)[0] for t in ticks_x_t]
        ticks_y_wgs = [twd97_to_wgs84(cx_t, t)[1] for t in ticks_y_t]

        ax.set_xticks(ticks_x_wgs)
        ax.set_xticklabels([f"{int(t)}" for t in ticks_x_t],
                           rotation=45, ha='right', fontsize=9)
        ax.set_yticks(ticks_y_wgs)
        ax.set_yticklabels([f"{int(t)}" for t in ticks_y_t], fontsize=9)

        ax.set_xlabel("TWD97 E (m)", fontsize=10, labelpad=8)
        ax.set_ylabel("TWD97 N (m)", fontsize=10, labelpad=8)
        ax.grid(True, linestyle='--', alpha=0.35, color='gray', linewidth=0.7)
        ax.tick_params(direction='in', length=5, which='major')

    ax.set_xlim(min_x - pad_x, max_x + pad_x)
    ax.set_ylim(min_y - pad_y, max_y + pad_y)

    # 等濃度填色區塊
    if show_fill:
        cf = ax.contourf(grid_x, grid_y, grid_z, levels=levels, cmap=colormap, alpha=alpha, extend='both')
    
    # 畫等濃度線
    if linewidth > 0:
        cs = ax.contour(grid_x, grid_y, grid_z, levels=levels, colors=line_color, linewidths=linewidth, linestyles=line_style, alpha=0.9)
        # 繪製標籤
        if show_label:
            labels = ax.clabel(cs, inline=True, fontsize=label_size, fmt='%1.0f')
            for l in labels:
                l.set_bbox(dict(facecolor='white', edgecolor=line_color, pad=2, alpha=0.9))

    # 背景設定 (互動模式透明；匯出模式白底 + 指北針 + 版面自適應)
    if not export_mode:
        fig.patch.set_alpha(0)
        ax.patch.set_alpha(0)
    else:
        # 等濃度線完成後疊加指北針
        if show_north:
            _draw_north_arrow(ax)
        fig.tight_layout(pad=1.5)
        fig.patch.set_facecolor('white')
        ax.patch.set_facecolor('white')

    # 設定圖片的真實經緯度邊界，對應 Leaflet ImageOverlay
    img_bounds = [
        [min_y - pad_y, min_x - pad_x], # SouthWest (lat, lon)
        [max_y + pad_y, max_x + pad_x]  # NorthEast (lat, lon)
    ]

    buf = io.BytesIO()
    if not export_mode:
        # 【超級關鍵】互動模式絕對不能使用 bbox_inches='tight'，否則裁切導致 Leaflet bounds 偏移
        plt.savefig(buf, format='png', transparent=True, pad_inches=0)
    else:
        # 匯出模式：tight 確保座標標籤完整顯示
        plt.savefig(buf, format='png', facecolor='white', bbox_inches='tight', dpi=150)
    plt.close(fig)
    buf.seek(0)
    img_base64 = base64.b64encode(buf.read()).decode('utf-8')

    # 6. 生成 GeoJSON 取線資料 (匯出用)
    features = []
    # 如果有繪製線條 (linewidth > 0) 才提取線段給 GeoJSON
    if linewidth > 0 and 'cs' in locals():
        if hasattr(cs, 'allsegs'):
            for i, segs in enumerate(cs.allsegs):
                if i < len(cs.levels):
                    val = cs.levels[i]
                else:
                    val = 0
                for seg in segs:
                    if len(seg) < 2: continue
                    coords = seg.tolist()
                    features.append(Feature(geometry=MultiLineString([coords]), properties={"value": float(val)}))
                
    fc = FeatureCollection(features)

    return {
        "status": "success",
        "image_base64": f"data:image/png;base64,{img_base64}",
        "bounds": img_bounds,
        "geojson": fc,
        "min_v": float(np.min(pv)),
        "max_v": float(np.max(pv))
    }

# 可選 AI 模組呼叫
def generate_ai_report(api_key: str, data: Dict[str, Any]) -> str:
    """呼叫 Gemini 生成數據分佈解釋與報告"""
    import google.generativeai as genai
    
    if not api_key:
         raise ValueError("需提供 Gemini API Key")
         
    genai.configure(api_key=api_key)

    # 動態搜尋可用的模型，避免 404 找不到
    raw_models = genai.list_models()
    all_models = [m.name for m in raw_models if 'generateContent' in m.supported_generation_methods and 'gemini' in m.name.lower()]
    modern = [m for m in all_models if any(v in m.lower() for v in ["1.5", "2.0", "2.5", "exp", "flash"])]
    available = modern if modern else all_models
    
    def rank(name):
        n = name.lower()
        s = 0
        if "2.5" in n: s += 3000
        if "2.0" in n: s += 2000
        if "1.5" in n: s += 1000
        if "pro" in n: s += 500
        if "flash" in n: s += 200
        return s
        
    model_names = sorted(available, key=rank, reverse=True)
    if not model_names:
        raise ValueError("您的 API Key 權限下找不到任何支援文本生成的 Gemini 模型。")
        
    system_instruction = "您是一位通用的 GIS 空間數據分析專家，專業領域涵蓋地貌高程、水文模擬、以及大氣環境。請務必嚴格根據提供的『數據類別』進行解釋。如果數據類別與空氣污染無關（例如：水位、高程、氣壓），請絕對不要提到『污染物』、『PM2.5』或『環保署標準』。"
    
    prompt = f"""
    【核心分析任務：嚴禁預設為空氣品質分析】
    請針對以下空間數據分析結果提供專業解析：
    
    1. 背景資訊：
       - 數據類別：{data.get("pollutant", "數值")} (<- 這是本次分析的唯一主角)
       - 中心座標：{data.get("center_lon", "N/A")}, {data.get("center_lat", "N/A")}
       - 數值範圍：{data.get("min_v", 0):.2f} ~ {data.get("max_v", 0):.2f}
       - 採用方法：{data.get("method", "IDW")}
    
    2. 報告需求：
       - 空間配置分析：描述高值與低值區域的地理分佈特徵。
       - 領域專業解析：針對目前的『數據類別』（如：水位高程），解釋其分佈的實際物理意涵或潛在影響。
       - 管理與改進建議：提供基於數據的專業後續處置建議。
    
    請以繁體中文撰寫。再次提醒：如果類別不是空氣污染物，請以純地理/水文角度出發，不要提及任何污染物術語。
    """
    
    last_err = ""
    for m_name in model_names:
        try:
            print(f"GIS AI 分析使用模型: {m_name}")
            # 優先使用系統指令模式
            model = genai.GenerativeModel(
                model_name=m_name,
                system_instruction=system_instruction
            )
            response = model.generate_content(prompt)
            return response.text
        except Exception as e:
            # 備援模式：將系統指令併入 Prompt 以相容舊模型
            try:
                model = genai.GenerativeModel(m_name)
                response = model.generate_content(f"{system_instruction}\n\n{prompt}")
                return response.text
            except Exception as e2:
                err = str(e2).lower()
                last_err = str(e2)
                if "429" in err or "quota" in err or "503" in err or "overloaded" in err:
                    continue
                else:
                    return f"AI 分析模型 {m_name} 發生錯誤: {e2}"
    return f"AI 分析發生錯誤: 所有可用的 Gemini 模型均已超過額度限制 (429 Quota Exceeded)。最後錯誤: {last_err}"
