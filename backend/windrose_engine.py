"""
windrose_engine.py
污染風花圖資料處理引擎
"""
import os
import json
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import io

BASE_DIR = Path(__file__).resolve().parent

# 專案只保留在目前服務程序記憶體中，不寫入 SQLite 或其他歷史檔案。
_PROJECTS = {}

# ======================================================
# 方位角映射 (16方位)
# ======================================================
DIR_BINS_16 = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5,
               180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5, 360]
DIR_LABELS_16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                  "S","SSW","SW","WSW","W","WNW","NW","NNW"]

DIR_BINS_8 = [0, 45, 90, 135, 180, 225, 270, 315, 360]
DIR_LABELS_8 = ["N","NE","E","SE","S","SW","W","NW"]

def classify_direction(deg: float, bins: int = 16) -> str:
    """將角度值分類至對應方位"""
    deg = deg % 360
    if bins == 8:
        b, l = DIR_BINS_8, DIR_LABELS_8
    else:
        b, l = DIR_BINS_16, DIR_LABELS_16

    for i in range(len(b) - 1):
        low, high = b[i], b[i+1]
        mid = (low + high) / 2
        if i == 0:
            if deg >= 360 - (b[1] - b[0]) / 2 or deg < high - (high - low) / 2:
                return l[0]
        if low <= deg < high:
            return l[i]
    return l[0]

# ======================================================
# CSV 解析
# ======================================================
def parse_csv(content: bytes, encoding: str = "utf-8") -> dict:
    """解析 CSV 並回傳欄位資訊"""
    try:
        # 使用 sep=None 和 engine='python' 讓 pandas 自動偵測分隔符號 (如空格, Tab, 逗號)
        df = pd.read_csv(
            io.BytesIO(content),
            sep=None,
            engine='python',
            encoding=encoding,
            encoding_errors="replace"
        )
    except Exception:
        df = pd.read_csv(
            io.BytesIO(content),
            sep=None,
            engine='python',
            encoding="big5",
            encoding_errors="replace"
        )

    # 自動偵測常見欄位名稱
    col_map = {}
    for col in df.columns:
        c = col.strip().lower()
        if any(k in c for k in ["wind_dir", "winddir", "wd", "wind dir", "風向"]):
            col_map.setdefault("direction", col)
        if any(k in c for k in ["wind_speed", "windspeed", "ws", "wind speed", "風速"]):
            col_map.setdefault("speed", col)
        if any(k in c for k in ["time", "date", "datetime", "timestamp", "時間", "日期"]):
            col_map.setdefault("time", col)
        if any(k in c for k in ["pm2.5", "pm25", "pm10", "no2", "so2", "co", "o3",
                                  "conc", "concentration", "濃度", "污染"]):
            col_map.setdefault("concentration", col)

    return {
        "columns": list(df.columns),
        "col_map": col_map,
        "rows": len(df),
        "preview": df.head(5).to_dict(orient="records")
    }

# ======================================================
# 污染風花圖資料計算
# ======================================================
def compute_frequency_windrose(
    df: pd.DataFrame,
    dir_col: str,
    speed_col: str,
    speed_bins: list,
    speed_labels: list,
    n_dirs: int = 16
) -> dict:
    """
    計算污染頻率風花圖資料
    回傳格式：{"directions": [...], "series": [{"name": label, "values": [...]}, ...]}
    """
    if n_dirs == 8:
        b, labels = DIR_BINS_8, DIR_LABELS_8
    else:
        b, labels = DIR_BINS_16, DIR_LABELS_16

    df = df.copy()
    df["_dir_cat"] = pd.cut(
        df[dir_col] % 360,
        bins=b, labels=labels[:-1] if len(labels) > n_dirs else labels,
        right=False, include_lowest=True
    )

    # 使用自訂級距
    df["_spd_cat"] = pd.cut(df[speed_col], bins=speed_bins, labels=speed_labels, right=False)
    df = df.dropna(subset=["_dir_cat", "_spd_cat"])

    total = len(df)
    result_series = []
    dir_order = list(dict.fromkeys(labels))[:n_dirs]

    for spd_label in speed_labels:
        sub = df[df["_spd_cat"] == spd_label]
        counts = sub.groupby("_dir_cat", observed=True).size()
        values = []
        for d in dir_order:
            pct = (counts.get(d, 0) / total * 100) if total > 0 else 0
            values.append(round(pct, 3))
        result_series.append({"name": spd_label, "values": values})

    return {"directions": dir_order, "series": result_series, "total_records": total}





def compute_3d_concentration_windrose(
    df: pd.DataFrame,
    dir_col: str,
    speed_col: str,
    conc_col: str,
    speed_bins: list,
    speed_labels: list,
    n_dirs: int = 16
) -> dict:
    import numpy as np
    from scipy.stats import gaussian_kde
    from scipy.ndimage import gaussian_filter

    # =========================
    # 0. 資料清理與抽取
    # =========================
    df = df.copy()
    # 確保原本的欄位能被正確轉為數值，非數值會變成 NaN 並被 dropna 過濾
    df[dir_col] = pd.to_numeric(df[dir_col], errors='coerce')
    df[speed_col] = pd.to_numeric(df[speed_col], errors='coerce')
    df[conc_col] = pd.to_numeric(df[conc_col], errors='coerce')

    df = df.dropna(subset=[dir_col, speed_col, conc_col])
    df = df[(df[speed_col] >= 0) & (df[conc_col] >= 0)]

    total = len(df)
    if total < 1:
        return {"grid": None, "total_records": 0, "conc_min": 0, "conc_max": 0}

    # =========================
    # 小數量資料模式 (N < 100)
    # 直接回傳點位分佈，不做平均值運算 (Nadaraya-Watson)
    # =========================
    if total < 100:
        pts = []
        for i in range(len(df)):
            pts.append({
                "r": float(df.iloc[i][speed_col]),
                "theta": float(df.iloc[i][dir_col]),
                "v": float(df.iloc[i][conc_col])
            })
        return {
            "mode": "scatter",
            "points": pts,
            "total_records": total,
            "conc_min": float(df[conc_col].min()),
            "conc_max": float(df[conc_col].max()),
            "max_speed": float(df[speed_col].max())
        }

    # =========================
    # 安全保護：防止 O(N*M) 導致 RAM 與 CPU 爆炸
    # =========================
    if total > 5000:
        df = df.sample(n=5000, random_state=42)

    wd = df[dir_col].values
    ws = df[speed_col].values
    value = df[conc_col].values

    if len(value) < 3:
        return {"grid": None, "total_records": total, "conc_min": 0, "conc_max": 0}

    # =========================
    # 1. 極座標 → Cartesian（對齊氣象正北）
    # =========================
    theta = np.radians(90 - wd)
    x = ws * np.cos(theta)
    y = ws * np.sin(theta)

    max_ws = speed_bins[-1] 
    if pd.isna(max_ws) or max_ws == 0:
        max_ws = ws.max()
        if pd.isna(max_ws) or max_ws == 0: max_ws = 1

    # =========================
    # 2. 建立兩個 KDE (條件平均核心: Nadaraya-Watson)
    # =========================
    # 低風速時污染不易擴散，物理影響大，高風速則具有較強稀釋效應
    ws_weight = 1 / (ws + 0.5)

    # (1) 分子 (以濃度與風速雙重加權的分佈)
    weights_num = value * ws_weight
    if np.sum(weights_num) == 0:
        weights_num += 1e-8
        
    kde_num = gaussian_kde(
        np.vstack([x, y]),
        weights=weights_num,
        bw_method=0.15
    )
    
    # (2) 分母 (純空間出現機率 × 風速權重衰減)
    weights_den = ws_weight.copy()
    if np.sum(weights_den) == 0:
        weights_den += 1e-8

    kde_den = gaussian_kde(
        np.vstack([x, y]),
        weights=weights_den,
        bw_method=0.15
    )

    # =========================
    # 3. 建立 grid (Cartesian 適用於 Plotly)
    # =========================
    grid_size = 150 # 為了前端維持效能與平滑度的解析度
    xi = np.linspace(-max_ws * 1.05, max_ws * 1.05, grid_size)
    yi = np.linspace(-max_ws * 1.05, max_ws * 1.05, grid_size)
    XI, YI = np.meshgrid(xi, yi)

    # =========================
    # 4. 計算 KDE
    # =========================
    grid_xy = np.vstack([XI.ravel(), YI.ravel()])
    Z_num = kde_num(grid_xy)
    Z_den = kde_den(grid_xy)

    # =========================
    # 5. 計算條件平均 (最重要)
    # =========================
    # 避免極端邊緣除以趨近於 0 的數值導致 Float overflow (inf)
    Z_den = np.maximum(Z_den, 1e-8)
    
    Z = (Z_num / Z_den) * np.mean(value)
    Z = Z.reshape(XI.shape)
    Z_den_grid = Z_den.reshape(XI.shape)

    # 在進入 gaussian_filter 之前，消滅所有可能的 inf 與 NaN，防止它在遞迴矩陣中擴散
    Z[np.isinf(Z) | np.isnan(Z)] = np.mean(value)

    # == KDE 表面再平滑 ==
    Z = gaussian_filter(Z, sigma=2.0)

    # =========================
    # 6. 避免除以0與極座標遮罩
    # =========================
    # R 靈魂：只顯示有真正發生過的地方，切除背景假平均橘色區
    threshold = np.percentile(Z_den_grid, 18)
    Z[Z_den_grid < threshold] = np.nan
    
    # 輕微過濾趨近 0 的值（保持真實感與平滑度的平衡）
    Z[Z < (np.nanmax(Z) * 0.02)] = np.nan
    
    # 物理邊界：風速外就不畫了
    R = np.sqrt(XI**2 + YI**2)
    Z[R > max_ws] = np.nan

    # =========================
    # 7. 對比度拉升
    # =========================
    # 確保返回的值是有限的，否則 JSON 序列化會失敗
    mask_finite = np.isfinite(Z)
    if np.any(mask_finite):
        conc_min = float(np.nanpercentile(Z, 5))
        conc_max = float(np.nanpercentile(Z, 95))
        # 再次檢查確保 conc_min/max 不是 inf
        if not np.isfinite(conc_min): conc_min = float(np.nanmin(Z[mask_finite])) if np.any(mask_finite) else 0
        if not np.isfinite(conc_max): conc_max = float(np.nanmax(Z[mask_finite])) if np.any(mask_finite) else 100
    else:
        conc_min, conc_max = 0, 100

    return {
        "grid": {
            "x": xi.round(3).tolist(),
            "y": yi.round(3).tolist(),
            "z": np.where(~np.isfinite(Z), None, np.round(Z, 3)).tolist()
        },
        "max_speed": float(max_ws),
        "total_records": total,
        "conc_min": conc_min,
        "conc_max": conc_max
    }


if __name__ == "__main__":
    # -----------------------------
    # 範例資料：你可以換成自己的資料
    # direction = 風向(度)
    # speed     = 風速
    # pm25      = 濃度
    # -----------------------------
    np.random.seed(42)
    n = 3000

    # 模擬兩個主要風向群聚
    d1 = np.random.normal(70, 30, n // 2)
    d2 = np.random.normal(240, 35, n // 2)
    direction = np.concatenate([d1, d2]) % 360

    # 模擬風速
    speed = np.concatenate([
        np.random.gamma(2.0, 1.8, n // 2),
        np.random.gamma(2.2, 1.5, n // 2)
    ])

    # 模擬 PM2.5：讓它跟風向與風速有一點關係
    pm25 = (
        12
        + 8 * np.sin(np.deg2rad(direction - 40))
        - 1.2 * speed
        + np.random.normal(0, 3, n)
    )
    pm25 = np.clip(pm25, 0, None)

    fig, ax, mean_grid, count_grid = compute_3d_concentration_windrose(
        direction=direction,
        speed=speed,
        concentration=pm25,
        dir_bins=16,
        speed_bin_width=1.0,
        min_count=2,
        cmap="gist_ncar",
        title="Windrose-like PM$_{2.5}$ Concentration Map",
        colorbar_label="mean",
        value_label=r"PM$_{2.5}$ (µg/m³)",
    )


# ======================================================
def list_projects() -> list:
    return sorted(
        [
            {
                "id": project["id"],
                "name": project["name"],
                "created_at": project["created_at"],
                "updated_at": project["updated_at"],
                "description": project["description"],
            }
            for project in _PROJECTS.values()
        ],
        key=lambda item: item["updated_at"],
        reverse=True,
    )

def save_project(project_id: Optional[str], name: str, csv_data: str, settings: dict, description: str = "") -> str:
    now = datetime.now().isoformat()
    if not project_id:
        project_id = str(uuid.uuid4())
    previous = _PROJECTS.get(project_id, {})
    _PROJECTS[project_id] = {
        "id": project_id,
        "name": name,
        "created_at": previous.get("created_at", now),
        "updated_at": now,
        "csv_data": csv_data,
        "settings": settings or {},
        "description": description,
    }
    return project_id

def load_project(project_id: str) -> Optional[dict]:
    project = _PROJECTS.get(project_id)
    return dict(project) if project else None

def delete_project(project_id: str) -> bool:
    return _PROJECTS.pop(project_id, None) is not None


# ======================================================
# AI 分析報告生成
# ======================================================
def generate_ai_report(api_key: str, data: dict) -> str:
    """呼叫 Gemini 生成污染風花圖分析與報告"""
    import google.generativeai as genai
    
    if not api_key:
         raise ValueError("需提供 Gemini API Key")
         
    genai.configure(api_key=api_key)

    # 動態搜尋可用的模型
    try:
        raw_models = genai.list_models()
        all_models = [m.name for m in raw_models if 'generateContent' in m.supported_generation_methods and 'gemini' in m.name.lower()]
    except Exception as e:
        return f"無法獲取模型列表: {e}。請檢查 API Key 是否有效。"

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
        
    # 根據資料結構準備 Prompt
    data_summary = json.dumps(data, ensure_ascii=False, indent=2)
    
    prompt = f"""
    您是一個專業的環境管理、大氣科學與空氣品質分析專家。
    我目前利用專業工具生成了「污染風花圖 (Wind Rose)」與「濃度風花圖」，以下是統計分析的摘要資料：
    
    {data_summary}
    
    請幫我撰寫一份詳盡且專業的分析報告，包含：
    1. **風場與污染頻率特徵分析**：分析盛行風向及其與高污染頻率的關聯。
    2. **可能污染源推測**：根據不同風速下的濃度分佈（低風速代表在地累積，高風速代表遠端傳輸），推測污染源可能的方位與特性。
    3. **具體改善與防制建議**：針對分析結果，提供具體的監測、調查或排放改善建議。
    
    用繁體中文回應，報告內容應具有科學深度但易於理解，格式使用 Markdown。
    """
    
    last_err = ""
    for m_name in model_names:
        try:
            print(f"Windrose AI 分析使用模型: {m_name}")
            model = genai.GenerativeModel(m_name)
            response = model.generate_content(prompt)
            return response.text
        except Exception as e:
            err = str(e).lower()
            last_err = str(e)
            if "429" in err or "quota" in err or "503" in err or "overloaded" in err:
                print(f"⚠️ 模型 {m_name} 超過配額受限，嘗試切換下一個模型...")
                continue
            else:
                return f"AI 分析模型 {m_name} 發生錯誤: {e}"
                
    return f"AI 分析發生錯誤: 所有可用的 Gemini 模型均已超過額度限制 (429 Quota Exceeded)。最後錯誤: {last_err}"
