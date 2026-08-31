"""
photo_filter_engine.py
照片智能篩選引擎 - 支援品質分析、重複偵測、人臉偵測
"""
import cv2
import numpy as np
from PIL import Image
import imagehash
import os
import urllib.request
from pathlib import Path
from itertools import combinations

# ============================================
# 1. 核心分析函數與人臉辨識模組
# ============================================

MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

FACE_DETECTOR_PATH = str(MODELS_DIR / "face_detection_yunet_2023mar.onnx")
FACE_RECOGNIZER_PATH = str(MODELS_DIR / "face_recognition_sface_2021dec.onnx")

def get_safe_model_path(path: str):
    """
    針對 Windows 上 OpenCV 讀取含有中文路徑模型失敗的問題，
    如果路徑包含非 ASCII 字元，則將模型複製到暫存目錄。
    """
    if os.name != 'nt': return path # 非 Windows 通常沒這問題
    
    try:
        path.encode('ascii')
        return path # 純 ASCII，安全
    except UnicodeEncodeError:
        # 包含非 ASCII 字元，採取備案
        import tempfile
        temp_dir = Path(tempfile.gettempdir()) / "ai_tool_models"
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        target_path = temp_dir / Path(path).name
        # 如果暫存檔不存在或檔案大小不同，則複製
        if not target_path.exists() or target_path.stat().st_size != Path(path).stat().st_size:
            import shutil
            shutil.copy2(path, target_path)
            print(f"[系統] 已將模型映射至安全路徑: {target_path}")
        return str(target_path)

def download_face_models():
    """下載 OpenCV 輕量級 ONNX 人臉辨識模型 (約 3MB)。"""
    base_url = "https://github.com/opencv/opencv_zoo/raw/main/models/"
    urls = {
        FACE_DETECTOR_PATH: base_url + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        FACE_RECOGNIZER_PATH: base_url + "face_recognition_sface/face_recognition_sface_2021dec.onnx"
    }
    for path, url in urls.items():
        if not os.path.exists(path):
            print(f"[系統] 正在下載本地人臉辨識模型: {Path(path).name} ...")
            try:
                urllib.request.urlretrieve(url, path)
                print(f"[系統] 模型下載完成: {path}")
            except Exception as e:
                print(f"[警告] 模型下載失敗: {e}")

# 全域預載模型實例，加速後續推論
_face_detector = None
_face_recognizer = None

def get_face_models(image_shape, score_threshold=0.5):
    global _face_detector, _face_recognizer
    download_face_models()
    
    if not os.path.exists(FACE_DETECTOR_PATH) or not os.path.exists(FACE_RECOGNIZER_PATH):
        return None, None
        
    h, w = image_shape[:2]
    # 取得安全路徑 (避開中文路徑問題)
    safe_detector_path = get_safe_model_path(FACE_DETECTOR_PATH)
    safe_recognizer_path = get_safe_model_path(FACE_RECOGNIZER_PATH)

    # 如果已經存在偵測器，檢查是否需要調整輸入大小或閾值
    if _face_detector is None:
        _face_detector = cv2.FaceDetectorYN.create(safe_detector_path, "", (w, h), score_threshold=score_threshold, nms_threshold=0.3)
    else:
        _face_detector.setInputSize((w, h))

    if _face_recognizer is None:
        _face_recognizer = cv2.FaceRecognizerSF.create(safe_recognizer_path, "")

    return _face_detector, _face_recognizer


def extract_face_feature(image_path: str):
    """
    載入圖片並萃取最大臉部的 128D 特徵。
    增加多重嘗試機制：縮圖處理、對比度增強、閾值調降。
    """
    try:
        # 支援中文路徑的 OpenCV 讀圖方式
        orig_img = cv2.imdecode(np.fromfile(image_path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if orig_img is None: return None

        # 1. 預處理：如果圖片太大，先等比例縮小 (有利於 YuNet 偵測)
        max_dim = 1280
        h, w = orig_img.shape[:2]
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            img_bgr = cv2.resize(orig_img, (int(w * scale), int(h * scale)))
        else:
            img_bgr = orig_img

        def try_detect(target_img, threshold=0.4):
            # 建立專用偵測器 (針對目標照片，我們容許較低的閾值以增加成功率)
            h_t, w_t = target_img.shape[:2]
            safe_path = get_safe_model_path(FACE_DETECTOR_PATH)
            temp_detector = cv2.FaceDetectorYN.create(safe_path, "", (w_t, h_t), score_threshold=threshold)
            _, faces = temp_detector.detect(target_img)
            return faces

        # 嘗試 A: 原始/縮放圖 + 標準閾值 (0.4)
        faces = try_detect(img_bgr, 0.4)

        # 嘗試 B: 若失敗，嘗試更低閾值 (0.2)
        if faces is None or len(faces) == 0:
            faces = try_detect(img_bgr, 0.2)

        # 嘗試 C: 若仍失敗，使用 CLAHE 增強對比度
        if faces is None or len(faces) == 0:
            lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8))
            cl = clahe.apply(l)
            limg = cv2.merge((cl,a,b))
            enhanced_img = cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)
            faces = try_detect(enhanced_img, 0.2)

        if faces is None or len(faces) == 0:
            return None
            
        # 找最大的臉
        biggest_face = max(faces, key=lambda f: f[2]*f[3])
        
        # 提取特徵 (使用全域 recognizer)
        _, recognizer = get_face_models(img_bgr.shape)
        if not recognizer: return None

        face_align = recognizer.alignCrop(img_bgr, biggest_face)
        feature = recognizer.feature(face_align)
        return feature
    except Exception as e:
        print(f"[警告] 提取特徵失敗 {image_path}: {e}")
        return None

def analyze_image(image_path: str, target_feature=None) -> dict:
    """
    對單張圖片進行完整的品質分析。
    可傳入 target_feature (從目標臉部提得的特徵向量) 來比對是否為同一人。
    回傳 dict 含: blur_score, brightness, contrast, has_face, is_target, width, height, file_size_kb
    """
    result = {
        "path": image_path,
        "filename": Path(image_path).name,
        "blur_score": 0.0,
        "brightness": 0.0,
        "contrast": 0.0,
        "has_face": False,
        "is_target": False,
        "width": 0,
        "height": 0,
        "file_size_kb": 0.0,
        "error": None
    }

    try:
        result["file_size_kb"] = round(os.path.getsize(image_path) / 1024, 1)

        # 讀取圖片
        # 支援中文路徑的 OpenCV 讀圖方式
        img_bgr = cv2.imdecode(np.fromfile(image_path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img_bgr is None:
            result["error"] = "無法讀取圖片"
            return result

        h, w = img_bgr.shape[:2]
        result["width"] = w
        result["height"] = h

        # 轉灰階
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

        # --- 清晰度 (Laplacian Variance) ---
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        blur_score = laplacian.var()
        result["blur_score"] = round(float(blur_score), 2)

        # --- 亮度 (平均像素值 0~255) ---
        brightness = float(np.mean(gray))
        result["brightness"] = round(brightness, 2)

        # --- 對比度 (標準差) ---
        contrast = float(np.std(gray))
        result["contrast"] = round(contrast, 2)

        # --- 人臉偵測 (ONNX 或 Haar) ---
        detector, recognizer = get_face_models(img_bgr.shape)
        if detector:
            _, faces = detector.detect(img_bgr)
            result["has_face"] = faces is not None and len(faces) > 0
            
            # --- 目標人臉比對 ---
            if result["has_face"] and target_feature is not None and recognizer is not None:
                for face in faces:
                    try:
                        face_align = recognizer.alignCrop(img_bgr, face)
                        feat = recognizer.feature(face_align)
                        
                        # 0 也就是 L2(Cosine) distance。 SFace 建議 Cosine 距離 < 0.363
                        # 注意：OpenCV SF_FR_COSINE 實際上回傳的是 Cosine Similarity (1.0 = 相同)
                        score = recognizer.match(target_feature, feat, cv2.FaceRecognizerSF_FR_COSINE)
                        if score >= 0.363: 
                            result["is_target"] = True
                            break
                    except:
                        pass
        else:
            # 沒網路下載不到模型時的備用傳統方案
            face_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            if os.path.exists(face_cascade_path):
                face_cascade = cv2.CascadeClassifier(face_cascade_path)
                faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
                result["has_face"] = len(faces) > 0

    except Exception as e:
        result["error"] = str(e)

    return result


def compute_phash(image_path: str) -> str | None:
    """計算圖片的感知雜湊 (pHash)，用於重複偵測。"""
    try:
        img = Image.open(image_path).convert("RGB")
        h = imagehash.phash(img)
        return str(h)
    except Exception:
        return None


def hamming_distance(hash1: str, hash2: str) -> int:
    """計算兩個十六進位 pHash 字串的 Hamming 距離。"""
    try:
        h1 = imagehash.hex_to_hash(hash1)
        h2 = imagehash.hex_to_hash(hash2)
        return h1 - h2
    except Exception:
        return 999


# ============================================
# 2. 批量分析與重複偵測
# ============================================

def batch_analyze(image_paths: list[str], target_feature=None) -> list[dict]:
    """對多張圖片進行批量分析，並附加 pHash。如有提供 target_feature 則進行比對。"""
    results = []
    for path in image_paths:
        info = analyze_image(path, target_feature=target_feature)
        info["phash"] = compute_phash(path)
        results.append(info)
    return results


def find_duplicates(analysis_results: list[dict], threshold: int = 8) -> dict[str, str]:
    """
    找出重複圖片組。
    回傳 {filename: group_id} 的對應表，group_id 相同表示為同組重複。
    """
    duplicates = {}  # filename -> group_id
    group_counter = 0

    # 建立 filename -> phash 的索引
    hash_map = {r["filename"]: r.get("phash") for r in analysis_results if r.get("phash")}

    filenames = list(hash_map.keys())
    visited = set()

    for i, fname_a in enumerate(filenames):
        if fname_a in visited:
            continue

        group = [fname_a]
        for fname_b in filenames[i+1:]:
            if fname_b in visited:
                continue
            dist = hamming_distance(hash_map[fname_a], hash_map[fname_b])
            if dist <= threshold:
                group.append(fname_b)

        if len(group) > 1:
            group_id = f"G{group_counter:03d}"
            group_counter += 1
            for fname in group:
                duplicates[fname] = group_id
                visited.add(fname)

    return duplicates


# ============================================
# 3. 分類決策
# ============================================

def classify_results(
    analysis_results: list[dict],
    blur_threshold: float = 80.0,
    min_brightness: float = 30.0,
    max_brightness: float = 220.0,
    hash_threshold: int = 8
) -> list[dict]:
    """
    根據閾值對每張圖片進行最終分類。
    status: 'keep' | 'blurry' | 'exposure' | 'duplicate'
    """
    # 先跑重複偵測
    dup_map = find_duplicates(analysis_results, threshold=hash_threshold)

    for item in analysis_results:
        fname = item["filename"]

        if item.get("error"):
            item["status"] = "error"
            item["reason"] = item["error"]
            continue

        if item["blur_score"] < blur_threshold:
            item["status"] = "blurry"
            item["reason"] = f"清晰度過低 ({item['blur_score']:.1f} < {blur_threshold})"
        elif item["brightness"] < min_brightness:
            item["status"] = "exposure"
            item["reason"] = f"圖片過暗 (亮度 {item['brightness']:.1f} < {min_brightness})"
        elif item["brightness"] > max_brightness:
            item["status"] = "exposure"
            item["reason"] = f"圖片過曝 (亮度 {item['brightness']:.1f} > {max_brightness})"
        elif fname in dup_map:
            item["status"] = "duplicate"
            item["reason"] = f"重複組 {dup_map[fname]}"
            item["dup_group"] = dup_map[fname]
        else:
            item["status"] = "keep"
            item["reason"] = "通過所有篩選"

    return analysis_results
