"""
pollution_tracker_engine.py
污染來源追蹤系統 — 逆軌跡計算與熱度圖引擎
"""
import json
import math
import numpy as np
import pandas as pd
import io
from datetime import datetime, timedelta
from typing import Optional, List
import windrose_engine


# ======================================================
# CSV 解析（時間欄位偵測）
# ======================================================
TIME_KEYWORDS = ["time", "date", "datetime", "timestamp", "時間", "日期",
                 "obs_time", "monitor_date", "sample_time", "hour"]

def parse_csv(content: bytes) -> dict:
    """解析 CSV 並回傳欄位資訊，增強時間欄位偵測"""
    base_info = windrose_engine.parse_csv(content)
    time_col = None
    for col in base_info["columns"]:
        cl = col.strip().lower()
        if any(k in cl for k in TIME_KEYWORDS):
            time_col = col
            break
    base_info["time_col"] = time_col
    return base_info


# ======================================================
# 資料清洗
# ======================================================
def clean_data(df: pd.DataFrame, dir_col: str, speed_col: str,
               conc_col: str, time_col: str) -> pd.DataFrame:
    """資料清洗：型別轉換、缺值處理、異常值移除"""
    df = df.copy()
    for col in [dir_col, speed_col, conc_col]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df[time_col] = pd.to_datetime(df[time_col], errors="coerce", dayfirst=False)
    df = df.dropna(subset=[time_col, dir_col, speed_col, conc_col])
    q1 = df[conc_col].quantile(0.01)
    q3 = df[conc_col].quantile(0.99)
    df = df[(df[conc_col] >= q1) & (df[conc_col] <= q3)]
    df[dir_col] = df[dir_col] % 360
    df = df[df[speed_col] >= 0]
    df = df.sort_values(time_col).reset_index(drop=True)
    return df


# ======================================================
# TWD97 <-> WGS84 轉換
# ======================================================
def twd97_to_wgs84(x: float, y: float):
    """TWD97 TM2 -> WGS84 (lon, lat)"""
    a = 6378137.0
    b = 6356752.314245
    lon0 = 121.0 * math.pi / 180
    k0 = 0.9999
    dx = 250000
    e = math.sqrt(1 - (b ** 2) / (a ** 2))

    x -= dx
    m = y / k0
    mu = m / (a * (1 - e**2/4 - 3*e**4/64 - 5*e**6/256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))

    j1 = 3*e1/2 - 27*e1**3/32
    j2 = 21*e1**2/16 - 55*e1**4/32
    j3 = 151*e1**3/96
    j4 = 1097*e1**4/512

    fp = mu + j1*math.sin(2*mu) + j2*math.sin(4*mu) + j3*math.sin(6*mu) + j4*math.sin(8*mu)

    e2 = e**2 / (1 - e**2)
    c1 = e2 * math.cos(fp)**2
    t1 = math.tan(fp)**2
    r1 = a * (1 - e**2) / (1 - e**2 * math.sin(fp)**2)**1.5
    n1 = a / math.sqrt(1 - e**2 * math.sin(fp)**2)
    d = x / (n1 * k0)

    q1 = n1 * math.tan(fp) / r1
    q2 = d**2 / 2
    q3 = (5 + 3*t1 + 10*c1 - 4*c1**2 - 9*e2) * d**4 / 24
    q4 = (61 + 90*t1 + 298*c1 + 45*t1**2 - 3*c1**2 - 252*e2) * d**6 / 720
    lat = fp - q1 * (q2 - q3 + q4)

    q5 = d
    q6 = (1 + 2*t1 + c1) * d**3 / 6
    q7 = (5 - 2*c1 + 28*t1 - 3*c1**2 + 8*e2 + 24*t1**2) * d**5 / 120
    lon = lon0 + (q5 - q6 + q7) / math.cos(fp)

    return math.degrees(lon), math.degrees(lat)


# ======================================================
# 逆軌跡計算
# ======================================================
def compute_back_trajectory(lat0: float, lon0: float,
                            wind_dir: float, wind_speed: float,
                            duration_hours: float = 1.0) -> dict:
    """
    計算單筆逆軌跡終點。
    wind_dir: 氣象風向（風從哪來的角度，0=N, 90=E, 180=S, 270=W）
    逆軌跡 = 風向本身指向污染源方向
    距離 = wind_speed(m/s) × duration(s) / 1000 → km
    """
    distance_km = wind_speed * duration_hours * 3600 / 1000

    # 風向角度 → 弧度（氣象風向：0=N, 順時針）
    bearing_rad = math.radians(wind_dir)

    # 地球半徑 km
    R = 6371.0
    lat0_rad = math.radians(lat0)
    lon0_rad = math.radians(lon0)

    # haversine 正算
    d_over_R = distance_km / R
    lat2_rad = math.asin(
        math.sin(lat0_rad) * math.cos(d_over_R) +
        math.cos(lat0_rad) * math.sin(d_over_R) * math.cos(bearing_rad)
    )
    lon2_rad = lon0_rad + math.atan2(
        math.sin(bearing_rad) * math.sin(d_over_R) * math.cos(lat0_rad),
        math.cos(d_over_R) - math.sin(lat0_rad) * math.sin(lat2_rad)
    )

    return {
        "lat": math.degrees(lat2_rad),
        "lng": math.degrees(lon2_rad),
        "distance_km": round(distance_km, 3),
        "bearing": wind_dir,
    }


def compute_all_trajectories(df: pd.DataFrame, dir_col: str, speed_col: str,
                              conc_col: str, time_col: str,
                              station_lat: float, station_lng: float,
                              duration_hours: float = 1.0) -> dict:
    """計算所有資料列的逆軌跡"""
    trajectories = []
    for _, row in df.iterrows():
        wd = float(row[dir_col])
        ws = float(row[speed_col])
        conc = float(row[conc_col])
        t = row[time_col]

        endpoint = compute_back_trajectory(station_lat, station_lng, wd, ws, duration_hours)
        trajectories.append({
            "time": t.isoformat() if hasattr(t, 'isoformat') else str(t),
            "wind_dir": wd,
            "wind_speed": round(ws, 2),
            "concentration": round(conc, 2),
            "endpoint_lat": endpoint["lat"],
            "endpoint_lng": endpoint["lng"],
            "distance_km": endpoint["distance_km"],
        })

    return {
        "trajectories": trajectories,
        "station": {"lat": station_lat, "lng": station_lng},
        "total": len(trajectories),
    }


# ======================================================
# 熱度圖資料（軌跡終點聚合）
# ======================================================
def compute_heatmap_data(df: pd.DataFrame, dir_col: str, speed_col: str,
                          conc_col: str, time_col: str,
                          station_lat: float, station_lng: float,
                          duration_hours: float = 1.0,
                          start_time: str = None, end_time: str = None) -> dict:
    """
    計算熱度圖資料：多時段軌跡終點聚合，濃度加權。
    回傳 [[lat, lng, intensity], ...] 供 Leaflet.heat 使用。
    """
    df = df.copy()
    if start_time:
        df = df[df[time_col] >= pd.to_datetime(start_time)]
    if end_time:
        df = df[df[time_col] <= pd.to_datetime(end_time)]

    if len(df) == 0:
        return {"points": [], "total": 0, "max_intensity": 0}

    # 正規化濃度作為權重
    conc_values = df[conc_col].values.astype(float)
    c_min = conc_values.min()
    c_max = conc_values.max()
    c_range = c_max - c_min if c_max > c_min else 1.0

    points = []
    for _, row in df.iterrows():
        wd = float(row[dir_col])
        ws = float(row[speed_col])
        conc = float(row[conc_col])

        ep = compute_back_trajectory(station_lat, station_lng, wd, ws, duration_hours)
        intensity = (conc - c_min) / c_range  # 0~1
        points.append([ep["lat"], ep["lng"], round(intensity, 4)])

    return {
        "points": points,
        "total": len(points),
        "max_intensity": round(float(c_max), 2),
        "min_intensity": round(float(c_min), 2),
    }


# ======================================================
# 高污染事件偵測
# ======================================================
def detect_pollution_events(df: pd.DataFrame, time_col: str, conc_col: str,
                             dir_col: str, speed_col: str,
                             threshold_percentile: float = 95,
                             min_duration_hours: float = 1) -> list:
    """偵測連續高污染事件"""
    df = df.copy().sort_values(time_col).reset_index(drop=True)
    threshold = df[conc_col].quantile(threshold_percentile / 100)
    df["_is_high"] = df[conc_col] >= threshold

    def circular_mean(angles):
        if len(angles) == 0:
            return 0
        rads = np.deg2rad(angles.values.astype(float))
        return round(float(np.rad2deg(np.arctan2(np.nanmean(np.sin(rads)), np.nanmean(np.cos(rads)))) % 360), 1)

    events = []
    in_event = False
    event_start = None
    event_rows = []

    for i, row in df.iterrows():
        if row["_is_high"]:
            if not in_event:
                in_event = True
                event_start = row[time_col]
                event_rows = [row]
            else:
                event_rows.append(row)
        else:
            if in_event:
                event_end = event_rows[-1][time_col]
                duration = (event_end - event_start).total_seconds() / 3600
                if duration >= min_duration_hours or len(event_rows) >= 2:
                    edf = pd.DataFrame(event_rows)
                    main_dir = circular_mean(edf[dir_col])
                    events.append({
                        "start": event_start.isoformat(),
                        "end": event_end.isoformat(),
                        "duration_hours": round(duration, 1),
                        "avg_concentration": round(float(edf[conc_col].mean()), 2),
                        "max_concentration": round(float(edf[conc_col].max()), 2),
                        "avg_wind_speed": round(float(edf[speed_col].mean()), 2),
                        "main_direction": round(main_dir, 1),
                        "record_count": len(event_rows),
                        "severity": "critical" if float(edf[conc_col].max()) >= df[conc_col].quantile(0.99) else "warning"
                    })
                in_event = False
                event_rows = []

    # 末尾事件
    if in_event and len(event_rows) >= 2:
        event_end = event_rows[-1][time_col]
        duration = (event_end - event_start).total_seconds() / 3600
        edf = pd.DataFrame(event_rows)
        main_dir = circular_mean(edf[dir_col])
        events.append({
            "start": event_start.isoformat(),
            "end": event_end.isoformat(),
            "duration_hours": round(duration, 1),
            "avg_concentration": round(float(edf[conc_col].mean()), 2),
            "max_concentration": round(float(edf[conc_col].max()), 2),
            "avg_wind_speed": round(float(edf[speed_col].mean()), 2),
            "main_direction": round(main_dir, 1),
            "record_count": len(event_rows),
            "severity": "critical" if float(edf[conc_col].max()) >= df[conc_col].quantile(0.99) else "warning"
        })

    return {
        "events": events,
        "threshold": round(float(threshold), 2),
        "total_events": len(events),
    }


# ======================================================
# AI 分析報告
# ======================================================
def generate_ai_report(api_key: str, data: dict) -> str:
    """呼叫 Gemini 生成污染來源追蹤分析報告"""
    import google.generativeai as genai
    if not api_key:
        raise ValueError("需提供 Gemini API Key")
    genai.configure(api_key=api_key)

    try:
        raw_models = genai.list_models()
        all_models = [m.name for m in raw_models
                      if 'generateContent' in m.supported_generation_methods
                      and 'gemini' in m.name.lower()]
    except Exception as e:
        return f"無法獲取模型列表: {e}"

    modern = [m for m in all_models
              if any(v in m.lower() for v in ["1.5", "2.0", "2.5", "exp", "flash"])]
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
        raise ValueError("找不到任何支援文本生成的 Gemini 模型。")

    data_summary = json.dumps(data, ensure_ascii=False, indent=2)

    prompt = f"""
    您是一個專業的環境管理、大氣科學與空氣品質分析專家。
    我使用「污染來源追蹤系統」進行了逆軌跡分析，以下是系統分析摘要：

    {data_summary}

    請幫我撰寫一份「污染來源追蹤分析報告」，包含以下章節：

    ## 1. 逆軌跡分析結果
    分析各時段逆軌跡的主要方向、距離範圍，判斷近場源與遠程傳輸源。

    ## 2. 高污染事件診斷
    針對偵測到的高污染事件，分析發生時間、主要風向、推測成因。

    ## 3. 污染來源方位研判
    綜合軌跡終點聚合（熱度圖），標記最可能的污染來源方位。
    區分「近場源（低風速高濃度）」與「遠程傳輸源（高風速高濃度）」。

    ## 4. 監測與防制建議
    提供後續監測方案與排放源調查方向。

    用繁體中文回應，格式使用 Markdown。
    """

    last_err = ""
    for m_name in model_names:
        try:
            model = genai.GenerativeModel(m_name)
            response = model.generate_content(prompt)
            return response.text
        except Exception as e:
            err = str(e).lower()
            last_err = str(e)
            if "429" in err or "quota" in err or "503" in err or "overloaded" in err:
                continue
            else:
                return f"AI 分析模型 {m_name} 發生錯誤: {e}"

    return f"AI 分析失敗: 所有模型均超過額度限制。最後錯誤: {last_err}"
