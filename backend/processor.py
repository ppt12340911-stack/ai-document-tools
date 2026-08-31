import os
import shutil
import subprocess
import docx
from docx.enum.text import WD_COLOR_INDEX
from docx.oxml.ns import qn
import fitz  # PyMuPDF
import numpy as np
import cv2

# Windows 本機版可使用 Microsoft Word；雲端 Linux 版改用 LibreOffice。
try:
    import pythoncom
    import win32com.client
except ImportError:
    pythoncom = None
    win32com = None

# EasyOCR 很重，改為選配；雲端版預設使用 RapidOCR。
try:
    import easyocr
except ImportError:
    easyocr = None
# (PaddleOCR 不需要手動設定執行檔路徑，它是由 Python 直接控制)

def convert_doc_to_docx(doc_path):
    """Converts a .doc file to .docx using Microsoft Word (Windows only)."""
    if not doc_path.lower().endswith(".doc"):
        return doc_path

    if os.name != "nt":
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            raise RuntimeError("雲端環境沒有可用的 LibreOffice，無法轉換 .doc 檔案。")
        output_dir = os.path.dirname(os.path.abspath(doc_path))
        subprocess.run(
            [soffice, "--headless", "--convert-to", "docx", "--outdir", output_dir, doc_path],
            check=True,
            capture_output=True,
            text=True,
        )
        converted_path = os.path.splitext(os.path.abspath(doc_path))[0] + ".docx"
        if not os.path.exists(converted_path):
            raise RuntimeError("LibreOffice 未產生可用的 .docx 檔案。")
        return converted_path

    if not pythoncom or not win32com:
        raise RuntimeError("此功能需要 Windows 與 Microsoft Word。")
    
    pythoncom.CoInitialize()
    word = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        abspath = os.path.abspath(doc_path)
        new_path = abspath.replace(".doc", ".docx")
        
        doc = word.Documents.Open(abspath)
        doc.SaveAs2(new_path, FileFormat=16)  # wdFormatXMLDocument
        doc.Close()
        return new_path
    except Exception as e:
        print(f"Error converting .doc to .docx: {str(e)}")
        raise e
    finally:
        if word:
            try: word.Quit()
            except: pass
        pythoncom.CoUninitialize()


def convert_word_to_pdf(word_path):
    """將 .doc 或 .docx 檔案透過 Microsoft Word 轉換為 PDF。
    
    使用 Word COM 自動化確保格式完全保留，包含頁首/頁尾、表格、頁碼等。
    """
    if os.name != "nt":
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            raise RuntimeError("雲端環境沒有可用的 LibreOffice，無法轉換 Word 檔案。")
        output_dir = os.path.dirname(os.path.abspath(word_path))
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", output_dir, word_path],
            check=True,
            capture_output=True,
            text=True,
        )
        pdf_path = os.path.splitext(os.path.abspath(word_path))[0] + ".pdf"
        if not os.path.exists(pdf_path):
            raise RuntimeError("LibreOffice 未產生可用的 PDF 檔案。")
        return pdf_path

    if not pythoncom or not win32com:
        raise RuntimeError("此功能需要 Windows 與 Microsoft Word。")

    pythoncom.CoInitialize()
    word = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        abspath = os.path.abspath(word_path)
        
        # 產生 PDF 輸出路徑：去除原本副檔名後加上 .pdf
        base, _ = os.path.splitext(abspath)
        pdf_path = base + ".pdf"
        
        doc = word.Documents.Open(abspath)
        # wdFormatPDF = 17
        doc.SaveAs2(pdf_path, FileFormat=17)
        doc.Close()
        print(f"Word → PDF 轉換成功: {pdf_path}")
        return pdf_path
    except Exception as e:
        print(f"Error converting Word to PDF: {str(e)}")
        raise e
    finally:
        if word:
            try: word.Quit()
            except: pass
        pythoncom.CoUninitialize()


import multiprocessing
import psutil
import time
import re

def optimize_ocr_result(text: str) -> str:
    """用 Regex 與 NLP 技巧優化 OCR 常見錯誤。"""
    # 移除連續多餘空白
    text = re.sub(r'[ \t]+', ' ', text)
    # 修復可能會被切散的數字(例如 1 0 0 -> 100)
    text = re.sub(r'(\d)\s+(?=\d)', r'\1', text)
    # 將標點符號正規化
    text = re.sub(r'[,，。](?=[^\s\n])', '，', text)
    return text.strip()

def _preprocess_image(image_path):
    """
    圖片預處理管線：大小檢查 → 壓縮限制(200~300 DPI) → 灰階 → 去噪 → 二值化/自適應對比。
    """
    try:
        # 1. 檔案大小檢查
        file_size_mb = os.path.getsize(image_path) / (1024 * 1024)
        if file_size_mb > 5:
            print(f"提醒：圖片大小達 {file_size_mb:.1f} MB，系統將自動進行強效壓縮以防止崩潰...")

        # 使用 numpy 讀取以支援中文路徑
        file_bytes = np.fromfile(image_path, dtype=np.uint8)
        img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        
        if img is None:
            print(f"警告：OpenCV 無法解析圖片 {image_path}")
            return image_path
        
        # 2. 限制最大解析度 (保護記憶體，設定等效 200 DPI 上限)
        h, w = img.shape[:2]
        max_dim = 2000
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            print(f"已縮放圖片至 {img.shape[1]}x{img.shape[0]} 以降低 OCR 負擔")
        
        # 3. 轉灰階
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 4. 去雜訊 (Non-local Means Denoising) - 這是去噪關鍵
        denoised = cv2.fastNlMeansDenoising(gray, None, h=10, templateWindowSize=7, searchWindowSize=21)
        
        # 5. 自適應對比與二值化 (CLAHE + Threshold)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(denoised)
        
        # 以簡單的銳利化輔助
        kernel = np.array([[0, -0.5, 0], [-0.5, 3, -0.5], [0, -0.5, 0]])
        sharpened = cv2.filter2D(enhanced, -1, kernel)
        
        preprocessed_path = image_path + "_preprocessed.png"
        _, buffer = cv2.imencode('.png', sharpened)
        buffer.tofile(preprocessed_path)
        
        return preprocessed_path
    except Exception as e:
        print(f"圖片預處理失敗 ({image_path}): {e}，將使用原圖辨識。")
        return image_path

def _run_ocr_subprocess(image_paths, queue):
    """供 multiprocessing.Process 呼叫的 OCR 核心獨立邏輯"""
    try:
        import psutil
        import os
        import easyocr
        import numpy as np
        import cv2
        
        process = psutil.Process(os.getpid())
        reader = easyocr.Reader(['ch_tra', 'en'], gpu=False)
        all_texts = []
        
        for processed_path in image_paths:
            # CPU / 記憶體監控 (避免系統過載)
            if process.memory_info().rss > 1.5 * 1024**3:  # 1.5GB
                queue.put({"error": "記憶體超過限制 (防崩潰保護已啟動)"})
                return
            if psutil.cpu_percent() > 90:
                print("警告: CPU 負載超過 90%")
                
            try:
                target_bytes = np.fromfile(processed_path, dtype=np.uint8)
                target_img = cv2.imdecode(target_bytes, cv2.IMREAD_COLOR)
                
                results = reader.readtext(target_img if target_img is not None else processed_path, detail=1)
                
                # 版面初步分析處理：僅保留信心度較高（非雜訊/圖形邊緣）的文字區塊
                filtered_texts = [text for (_, text, conf) in results if conf > 0.15]
                all_texts.append("\n".join(filtered_texts))
            except Exception as e:
                all_texts.append(f"[單頁辨識發生錯誤: {e}]")
                
        queue.put({"texts": all_texts})
    except Exception as e:
        queue.put({"error": str(e)})


def _run_rapid_subprocess(image_paths, queue):
    """供 multiprocessing.Process 呼叫的 RapidOCR 獨立邏輯"""
    try:
        from rapidocr_onnxruntime import RapidOCR
        import numpy as np
        import cv2
        import os
        
        # 初始化 RapidOCR (預設即包含繁體中文模型支援)
        ocr = RapidOCR()
            
        all_texts = []
        
        for processed_path in image_paths:
            try:
                target_bytes = np.fromfile(processed_path, dtype=np.uint8)
                target_img = cv2.imdecode(target_bytes, cv2.IMREAD_COLOR)
                
                # 執行辨識
                input_data = target_img if target_img is not None else processed_path
                result, _ = ocr(input_data)
                
                # RapidOCR 的結果格式為 [line[0](box), line[1](text, score)]
                page_texts = []
                if result:
                    for line in result:
                        text = line[1]
                        page_texts.append(text)
                
                all_texts.append("\n".join(page_texts))
            except Exception as e:
                all_texts.append(f"[單頁 RapidOCR 辨識發生錯誤: {e}]")
                
        queue.put({"texts": all_texts})
    except Exception as e:
        queue.put({"error": str(e)})


def perform_local_ocr(file_paths: list, engine: str = 'easyocr'):
    """
    對一或多個檔案路徑進行本地 OCR 文字提取。
    支援圖片 (.jpg, .png) 與 PDF，全面啟動分批機制與 Timeout 防護。
    
    參數:
        file_paths: 檔案路徑列表
        engine: 'tesseract'（RapidOCR）或 'easyocr'
    """
    if engine == "easyocr" and easyocr is None:
        raise RuntimeError("EasyOCR 未安裝，請改用 RapidOCR，或在本機版安裝 EasyOCR。")

    combined_text = []
    temp_files = []  
    
    for path in file_paths:
        if not os.path.exists(path):
            continue
            
        ext = os.path.splitext(path)[1].lower()
        print(f"正在對檔案進行本地 OCR: {os.path.basename(path)}")
        
        try:
            current_targets = []
            
            # 處理 PDF：分批提取為圖片
            if ext == ".pdf":
                print(f"📄 偵測到 PDF，正在提取頁面...")
                doc = fitz.open(path)
                for i, page in enumerate(doc):
                    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
                    tmp_page_img = f"{path}_page_{i}.png"
                    pix.save(tmp_page_img)
                    current_targets.append(tmp_page_img)
                    temp_files.append(tmp_page_img)
                doc.close()
            else:
                current_targets = [path]

            # 影像前處理
            processed_targets = []
            for target in current_targets:
                processed_path = _preprocess_image(target)
                if processed_path != target:
                    temp_files.append(processed_path)
                processed_targets.append(processed_path)

            # 分批執行 OCR (Queue + 獨立進程)
            batch_size = 10
            file_extracted_texts = []
            
            for i in range(0, len(processed_targets), batch_size):
                batch_paths = processed_targets[i:i+batch_size]
                queue = multiprocessing.Queue()
                
                if engine == 'tesseract' or engine == 'paddleocr' or engine == 'rapidocr':
                    p = multiprocessing.Process(target=_run_rapid_subprocess, args=(batch_paths, queue))
                    engine_name = "RapidOCR"
                else:
                    p = multiprocessing.Process(target=_run_ocr_subprocess, args=(batch_paths, queue))
                    engine_name = "EasyOCR"
                
                print(f"啟動 {engine_name} 進程處理批次 {i//batch_size + 1} (包含 {len(batch_paths)} 頁)...")
                p.start()
                
                # 設定 Timeout（每張圖最高容忍 30 秒，超過則強制中止）
                timeout_limit = len(batch_paths) * 30
                p.join(timeout=timeout_limit)
                
                if p.is_alive():
                    p.terminate()
                    p.join()
                    raise TimeoutError(f"處理超過時間限制 ({timeout_limit} 秒)")
                
                if not queue.empty():
                    result = queue.get()
                    if "error" in result:
                        raise RuntimeError(result["error"])
                    elif "texts" in result:
                        for raw_text in result["texts"]:
                            # 正則結果優化
                            optimized = optimize_ocr_result(raw_text)
                            file_extracted_texts.append(optimized)
                else:
                    raise RuntimeError("系統資源不足或子程序意外崩潰")
            
            combined_text.append(f"--- 檔案: {os.path.basename(path)} ---")
            combined_text.append("\n\n".join(file_extracted_texts))
            
        except Exception as e:
            print(f"⚠️ OCR 完全失敗 ({path}): {str(e)}")
            combined_text.append(f"--- 檔案: {os.path.basename(path)} ---")
            combined_text.append(f"檔案過大或過於複雜 (系統已保護性中斷)。錯誤細節：{str(e)}")
            combined_text.append(f"請嘗試拆分檔案後再試。")
    
    # 清理資源
    for tmp in temp_files:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except:
            pass
            
    return "\n\n".join(combined_text)


def perform_cloud_ocr(file_paths: list, api_key: str):
    """
    使用 Google Gemini 專業模型對圖片或 PDF 進行高精準度雲端 OCR 辨識。
    """
    genai.configure(api_key=api_key)
    combined_text = []
    
    # 建立通用的分析 Prompt
    prompt = """請精確辨識並提取檔案中的所有文字內容。
如果檔案中包含手寫文字、表格或複雜版面，請盡可能按照閱讀順序完整呈現。
直接輸出內容文字即可，不要加入額外的說明訊息。"""

    # 動態尋找可用的模型 (優先使用 Flash 因其成本較低且速度快)
    try:
        models = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods and 'gemini' in m.name.lower()]
        target_model = next((m for m in models if "flash" in m.lower()), models[0] if models else "models/gemini-1.5-flash")
        model = genai.GenerativeModel(target_model)
        
        for path in file_paths:
            if not os.path.exists(path): continue
            
            print(f"正在對檔案進行雲端 OCR: {os.path.basename(path)}")
            ext = os.path.splitext(path)[1].lower()
            
            try:
                contents = [prompt]
                
                # Gemini 支持直接上傳 PDF 或圖片
                if ext == ".pdf":
                    pdf_file = genai.upload_file(path=path)
                    contents.append(pdf_file)
                    # 分析並等待
                    response = model.generate_content(contents)
                    genai.delete_file(pdf_file.name) # 刪服端暫存
                else:
                    img = PIL.Image.open(path)
                    contents.append(img)
                    response = model.generate_content(contents)
                
                combined_text.append(f"--- 檔案: {os.path.basename(path)} (Gemini Cloud) ---")
                combined_text.append(response.text)
            except Exception as e:
                print(f"雲端 OCR 失敗 ({path}): {e}")
                combined_text.append(f"--- 檔案: {os.path.basename(path)} (雲端分析失敗) ---")
                
        return "\n\n".join(combined_text)
    except Exception as e:
        print(f"初始化雲端 OCR 模型失敗: {e}")
        return f"錯誤：無法啟動雲端辨識引擎 ({str(e)})"

# ==========================================
# 逐字稿辨識工具 (Transcript)
# ==========================================
import PIL.Image
import google.generativeai as genai

def download_youtube_audio(youtube_url, output_dir):
    """從 YouTube 提取音訊並儲存到指定目錄，回傳本地路徑"""
    import yt_dlp
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    outtmpl = os.path.join(output_dir, f'%(id)s.%(ext)s')
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': outtmpl,
        'quiet': True,
        'no_warnings': True,
        'extract_audio': True
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(youtube_url, download=True)
        filename = ydl.prepare_filename(info_dict)
        return filename

def analyze_transcript(image_paths, audio_path, api_key):
    """
    結合手寫圖片(多張)與選填音檔，呼叫 Gemini 進行逐字稿辨識。
    嚴格強制以手寫稿為主，音訊僅供輔助參考。
    """
    genai.configure(api_key=api_key)
    
    prompt = """這是一份審查委員的手寫稿，請進行 100% 精準的文字辨識。
會議內容背景為「環境工程」或「生態保育」相關領域，請以此專有名詞與脈絡進行理解。

音訊與影片內容「僅作為輔助參考」，當手寫字跡難以辨識時才藉由語音脈絡推斷可能的字詞，絕不可自行延伸、編造或刪減手寫稿原有的內容。
請直接輸出辨識出的逐字稿結果，不要加入額外的解釋或心得。"""

    contents = [prompt]
    uploaded_files = []
    
    try:
        # 上傳音檔到 Google (如果檔案大於 20MB，API 要求必需使用 File API)
        if audio_path and os.path.exists(audio_path):
            print(f"Uploading audio to Gemini: {audio_path}")
            audio_file = genai.upload_file(path=audio_path)
            contents.append(audio_file)
            uploaded_files.append(audio_file)
            
        # 本地圖片可直接用 PIL 開啟丟給 Gemini (1.5 pro 支援 Multimodal)
        for img_path in image_paths:
            if img_path.lower().endswith('.pdf'):
                # 如果是 PDF，也上傳到 Gemini
                pdf_file = genai.upload_file(path=img_path)
                contents.append(pdf_file)
                uploaded_files.append(pdf_file)
            else:
                img = PIL.Image.open(img_path)
                contents.append(img)
            
        # 動態尋找可用的模型
        available_models = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods and 'gemini' in m.name.lower()]
        
        if not available_models:
            raise Exception("無可用的 Gemini 模型可以分析。")
            
        # 安全排序：2.x > 1.5 > 其他
        model_names = sorted(available_models, key=lambda x: ("2.0" in x or "2.5" in x) or ("1.5" in x), reverse=True)
        
        target_model_name = None
        for name in model_names:
            try:
                # 測試一下模型是否能夠初始化
                temp = genai.GenerativeModel(name)
                target_model_name = name
                model = temp
                break
            except:
                continue
                
        if not target_model_name:
            raise Exception("全部列出的模型皆無法啟動或呼叫。")
            
        print(f"Using Transcript Model: {target_model_name}")
        response = model.generate_content(contents)
        
        return response.text
        
    except Exception as e:
        print(f"Error in transcript analysis: {e}")
        raise e
        
    finally:
        # 處理完畢後，確保清除 Google 伺服器端的暫存檔以免佔用配額
        for f in uploaded_files:
            try:
                genai.delete_file(f.name)
            except:
                pass
