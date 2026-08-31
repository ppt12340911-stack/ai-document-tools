import os
import argparse
import uuid
import shutil
import json
import re
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response, BackgroundTasks, Body
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from pathlib import Path
import asyncio
import time
import docx
import fitz  # PyMuPDF
import google.generativeai as genai
from pydantic import BaseModel
import asyncio
import zipfile
import database
import processor
import proofreader
import PIL.Image
import io
import gis_engine
import windrose_engine
import pdf_engine
import photo_filter_engine
import pollution_tracker_engine

app = FastAPI(title="AI 文件工具平台")

# CORS middleware
configured_origins = [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGIN", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# === 核心路徑設定 (使用 Pathlib 強化穩定性) ===
BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
FRONTEND_DIR = ROOT_DIR / "frontend"


def safe_upload_filename(filename: Optional[str], fallback: str = "upload.bin") -> str:
    """只保留上傳檔名，避免檔名被用來穿越暫存目錄。"""
    raw_name = str(filename or "").replace("\\", "/").replace("\x00", "")
    clean_name = raw_name.rsplit("/", 1)[-1].strip()
    return clean_name or fallback

print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 伺服器核心路徑: {BASE_DIR}")
print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 前端資源路徑: {FRONTEND_DIR}")

# 快取控制 Middleware: 防止瀏覽器記住舊的 portal 內容
@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    response = await call_next(request)
    # 強制不快取 HTML、JS、CSS 檔案，避免 portal 更新後 user 卻看到舊版
    path = request.url.path
    if path.endswith("/") or ".html" in path or ".js" in path or ".css" in path:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# 每個工具的靜態檔案掛載
app.mount("/word-to-pdf", StaticFiles(directory=str(FRONTEND_DIR / "word-to-pdf"), html=True), name="word-to-pdf")
app.mount("/transcript", StaticFiles(directory=str(FRONTEND_DIR / "transcript"), html=True), name="transcript")
app.mount("/ocr", StaticFiles(directory=str(FRONTEND_DIR / "ocr"), html=True), name="ocr")
app.mount("/proofreader", StaticFiles(directory=str(FRONTEND_DIR / "proofreader"), html=True), name="proofreader")
app.mount("/gis", StaticFiles(directory=str(FRONTEND_DIR / "gis"), html=True), name="gis")
app.mount("/windrose", StaticFiles(directory=str(FRONTEND_DIR / "windrose"), html=True), name="windrose")
app.mount("/photo-filter", StaticFiles(directory=str(FRONTEND_DIR / "photo-filter"), html=True), name="photo-filter")
app.mount("/pollution-tracker", StaticFiles(directory=str(FRONTEND_DIR / "pollution-tracker"), html=True), name="pollution-tracker")

# === 工作目錄設定 ===
CONVERT_DIR = BASE_DIR / "uploads" / "conversions"
TRANSCRIPT_DIR = BASE_DIR / "uploads" / "transcript"
OCR_DIR = BASE_DIR / "uploads" / "ocr"
PROOFREAD_DIR = BASE_DIR / "uploads" / "proofreader"
PHOTO_FILTER_DIR = BASE_DIR / "uploads" / "photo_filter"

CONVERT_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
OCR_DIR.mkdir(parents=True, exist_ok=True)
PROOFREAD_DIR.mkdir(parents=True, exist_ok=True)
PHOTO_FILTER_DIR.mkdir(parents=True, exist_ok=True)

# 暫存轉換結果 (正式應用應放 DB 或 Redis)
conversion_results = {}
proofread_results = {}

def perform_cleanup(target_days=7):
    """檢查並刪除超過指定天數的實體檔案"""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 啟動過期暫存檔案檢查 (>{target_days}天)...")
    try:
        now_ts = time.time()
        age_in_seconds = target_days * 86400
        deleted_count = 0
        
        # 取得所有被釘選保護的實體路徑
        pinned_paths = database.get_all_pinned_filepaths()

        # 清除轉換工具的 PDF 暫存資料夾
        if os.path.exists(CONVERT_DIR):
            for item in os.listdir(CONVERT_DIR):
                item_path = os.path.join(CONVERT_DIR, item)
                if os.path.isdir(item_path):
                    # 避免去刪除資料庫或設定檔等
                    if now_ts - os.path.getmtime(item_path) > age_in_seconds:
                        # 檢查其下是否有檔案被釘選
                        has_pinned_child = False
                        # 因為這是一個資料夾，所以要檢查這個路徑或它的子檔案是否被保護
                        for root, _, files in os.walk(item_path):
                            for f in files:
                                if os.path.normpath(os.path.join(root, f)) in pinned_paths:
                                    has_pinned_child = True
                                    break
                            if has_pinned_child: break
                                    
                        if not has_pinned_child:
                            shutil.rmtree(item_path)
                            deleted_count += 1
        
        # 清除 逐字稿 工具的檔案區
        if os.path.exists(TRANSCRIPT_DIR):
            for item in os.listdir(TRANSCRIPT_DIR):
                item_path = os.path.join(TRANSCRIPT_DIR, item)
                if os.path.isdir(item_path):
                    if now_ts - os.path.getmtime(item_path) > age_in_seconds:
                        has_pinned_child = False
                        for root, _, files in os.walk(item_path):
                            for f in files:
                                if os.path.normpath(os.path.join(root, f)) in pinned_paths:
                                    has_pinned_child = True
                                    break
                            if has_pinned_child: break
                                    
                        if not has_pinned_child:
                            shutil.rmtree(item_path)
                            deleted_count += 1
                            
        # 清除 OCR 工具的檔案區
        if os.path.exists(OCR_DIR):
            for item in os.listdir(OCR_DIR):
                item_path = os.path.join(OCR_DIR, item)
                if os.path.isdir(item_path):
                    if now_ts - os.path.getmtime(item_path) > age_in_seconds:
                        shutil.rmtree(item_path)
                        deleted_count += 1

        # 清除 校稿系統 的檔案區
        if os.path.exists(PROOFREAD_DIR):
            for item in os.listdir(PROOFREAD_DIR):
                item_path = os.path.join(PROOFREAD_DIR, item)
                if os.path.isdir(item_path):
                    if now_ts - os.path.getmtime(item_path) > age_in_seconds:
                        has_pinned_child = False
                        for root, _, files in os.walk(item_path):
                            for f in files:
                                if os.path.normpath(os.path.join(root, f)) in pinned_paths:
                                    has_pinned_child = True
                                    break
                            if has_pinned_child: break
                        if not has_pinned_child:
                            shutil.rmtree(item_path)
                            deleted_count += 1
        
        if deleted_count > 0:
            print(f"[OK] 成功清理 {deleted_count} 筆已逾期的舊暫存檔。")
        else:
            print("[INFO] 目前無過期檔案需要清理。")
    except Exception as e:
        print(f"[ERR] 清理過程中遭遇錯誤: {e}")

async def scheduled_cleanup_task():
    """背景常駐排程：每12小時檢查一次過期檔案"""
    while True:
        # 睡 12 個小時 (43200 秒)
        await asyncio.sleep(43200)
        perform_cleanup(7) # 清理超過 7 天的檔案

@app.on_event("startup")
async def startup_event():
    # 服務器啟動時，第一時間補查是否有遺留的老舊檔案
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 啟動過期暫存檔案檢查 (>7天)...")
    perform_cleanup(7) 
    
    # 掛載為背景循環任務
    asyncio.create_task(scheduled_cleanup_task())


@app.post("/api/convert-to-pdf")
async def convert_to_pdf_endpoint(request: Request, files: List[UploadFile] = File(...)):
    async def event_generator():
        conversion_id = str(uuid.uuid4())
        conv_dir = (CONVERT_DIR / conversion_id)
        conv_dir.mkdir(parents=True, exist_ok=True)
        
        results = []
        total = len(files)
        
        for i, file in enumerate(files):
            file_id = str(uuid.uuid4())
            original_name = safe_upload_filename(file.filename)
            ext = os.path.splitext(original_name)[1].lower()
            save_path = str(conv_dir / f"{file_id}_orig{ext}")
            
            with open(save_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
                
            pdf_path = None
            error_msg = None
            
            try:
                if ext == ".doc":
                    docx_path = processor.convert_doc_to_docx(save_path)
                    pdf_path = processor.convert_word_to_pdf(docx_path)
                elif ext == ".docx":
                    pdf_path = processor.convert_word_to_pdf(save_path)
                else:
                    error_msg = "不支援的檔案格式"
            except Exception as e:
                error_msg = str(e)
                
            if pdf_path and os.path.exists(pdf_path):
                results.append({
                    "id": file_id,
                    "original_name": original_name,
                    "filename": os.path.splitext(original_name)[0] + ".pdf",
                    "pdf_path": pdf_path,
                    "status": "success"
                })
            else:
                results.append({
                    "id": file_id,
                    "original_name": original_name,
                    "filename": original_name,
                    "status": "error",
                    "error": error_msg or "轉換失敗"
                })
                
            # 發送進度
            yield f"data: {json.dumps({'type': 'progress', 'completed': i + 1, 'total': total, 'filename': original_name})}\n\n"
            await asyncio.sleep(0.1) # 讓 buffer 可以 flush
            
        conversion_results[conversion_id] = results
        
        # 發送完成
        yield f"data: {json.dumps({'type': 'complete', 'conversion_id': conversion_id, 'results': results})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/api/download-pdf/{conversion_id}/{file_id}")
async def download_single_pdf(conversion_id: str, file_id: str):
    results = conversion_results.get(conversion_id)
    if not results:
        raise HTTPException(status_code=404, detail="找不到轉換紀錄")
    session = {"files": results}
        
    for r in session['files']:
        if r['id'] == file_id and r['status'] == 'success':
            return FileResponse(r['pdf_path'], filename=r['filename'], media_type='application/pdf')
            
    raise HTTPException(status_code=404, detail="檔案不存在或轉換失敗")

@app.get("/api/download-all-pdfs/{conversion_id}")
async def download_all_pdfs(conversion_id: str):
    results = conversion_results.get(conversion_id)
    if not results:
        raise HTTPException(status_code=404, detail="找不到轉換紀錄")
    session = {"files": results}
        
    success_files = [r for r in session['files'] if r['status'] == 'success']
    if not success_files:
        raise HTTPException(status_code=400, detail="沒有成功的檔案可供下載")
        
    memory_file = io.BytesIO()
    with zipfile.ZipFile(memory_file, 'w') as zf:
        for f in success_files:
            zf.write(f['pdf_path'], arcname=f['filename'])
            
    memory_file.seek(0)
    from urllib.parse import quote
    encoded_filename = quote(f"轉換結果_{datetime.now().strftime('%Y%m%d')}.zip")
    return StreamingResponse(
        memory_file,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
    )

# ===========================================
# PDF Unlock API
# ===========================================
@app.post("/api/pdf/unlock")
@app.post("/api/pdf/unlock/") # 增加帶斜線的對應，避免 405/307 重定向問題
async def unlock_pdf_endpoint(files: List[UploadFile] = File(...)):
    try:
        # 如果只有一個檔案，直接解鎖並回傳
        if len(files) == 1:
            file = files[0]
            content = await file.read()
            original_name = safe_upload_filename(file.filename, "document.pdf")
            unlocked_bytes = pdf_engine.unlock_pdf(content, original_name)
            from urllib.parse import quote
            encoded_filename = quote(f"unlocked_{original_name}")
            return StreamingResponse(
                io.BytesIO(unlocked_bytes),
                media_type="application/pdf",
                headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
            )
        
        # 多個檔案則打包成 ZIP
        memory_file = io.BytesIO()
        with zipfile.ZipFile(memory_file, 'w') as zf:
            errors = []
            for file in files:
                try:
                    content = await file.read()
                    original_name = safe_upload_filename(file.filename, "document.pdf")
                    unlocked_bytes = pdf_engine.unlock_pdf(content, original_name)
                    zf.writestr(f"unlocked_{original_name}", unlocked_bytes)
                except Exception as e:
                    errors.append(f"檔案 {safe_upload_filename(file.filename)} 解鎖失敗: {str(e)}")
            
            if errors:
                zf.writestr("error_report.txt", "\n".join(errors))
        
        memory_file.seek(0)
        return StreamingResponse(
            memory_file,
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=unlocked_pdfs.zip"}
        )

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"批量解鎖過程發生未知錯誤: {str(e)}")

# ===========================================
# PDF to Image API
# ===========================================
@app.post("/api/pdf/to-image")
async def pdf_to_image_endpoint(
    file: UploadFile = File(...),
    format: str = Form("png"),
    dpi: int = Form(300)
):
    try:
        content = await file.read()
        original_name = safe_upload_filename(file.filename, "document.pdf")
        img_bytes, out_filename, is_zip = pdf_engine.pdf_to_images(content, original_name, fmt=format, dpi=dpi)
        
        media_type = "application/zip" if is_zip else f"image/{format}"
        
        from urllib.parse import quote
        encoded_filename = quote(out_filename)
        
        return StreamingResponse(
            io.BytesIO(img_bytes),
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF 轉圖片失敗: {str(e)}")

# 後續可在此處處理系統停機或重啟

# ============================================
# API: 逐字稿辨識工具
# ============================================

@app.post("/api/transcript")
async def create_transcript(
    api_key: str = Form(...),
    youtube_url: str = Form(""),
    images: List[UploadFile] = File(...),
    audio: UploadFile = File(None)
):
    import uuid
    session_id = str(uuid.uuid4())
    session_dir = os.path.join(TRANSCRIPT_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    
    # 儲存圖片
    image_paths = []
    for img in images:
        if img.filename:
            image_name = safe_upload_filename(img.filename, f"image_{uuid.uuid4().hex}.bin")
            path = os.path.join(session_dir, f"{uuid.uuid4().hex[:8]}_{image_name}")
            with open(path, "wb") as f:
                f.write(await img.read())
            image_paths.append(path)
            
    # 處理音檔 (使用者上傳優先，YT次之)
    audio_path = None
    if audio and audio.filename:
        audio_name = safe_upload_filename(audio.filename, f"audio_{uuid.uuid4().hex}.bin")
        audio_path = os.path.join(session_dir, f"{uuid.uuid4().hex[:8]}_{audio_name}")
        with open(audio_path, "wb") as f:
            f.write(await audio.read())
    elif youtube_url:
        try:
            audio_path = processor.download_youtube_audio(youtube_url, session_dir)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"YouTube 音訊下載失敗: {str(e)}")
            
    # 呼叫 Gemini
    try:
        result_text = processor.analyze_transcript(image_paths, audio_path, api_key)
        
        return {
            "session_id": session_id,
            "status": "success",
            "result_text": result_text
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失敗: {str(e)}")

# ============================================
# API: 本地端 OCR 文字辨識
# ============================================

@app.post("/api/ocr")
async def extract_ocr_text(
    files: List[UploadFile] = File(...),
    api_key: str = Form(None),
    engine: str = Form("tesseract")
):
    session_id = str(uuid.uuid4())
    session_dir = os.path.join(OCR_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    
    saved_paths = []
    for file in files:
        file_name = safe_upload_filename(file.filename)
        ext = os.path.splitext(file_name)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".pdf"):
            continue
            
        save_path = os.path.join(session_dir, file_name)
        if os.path.exists(save_path):
            save_path = os.path.join(session_dir, f"{uuid.uuid4().hex[:8]}_{file_name}")
        with open(save_path, "wb") as f:
            f.write(await file.read())
        saved_paths.append(save_path)
        
    if not saved_paths:
        raise HTTPException(status_code=400, detail="沒有可辨識的有效檔案 (支援圖檔與 PDF)。")
        
    try:
        # 如果有提供 API Key，優先使用雲端 OCR (Gemini) 以確保最高精準度
        if api_key and api_key.strip():
            print(f"🚀 使用雲端 Gemini 進行 OCR 辨識 (Session: {session_id})")
            result_text = await asyncio.to_thread(processor.perform_cloud_ocr, saved_paths, api_key)
            method_name = "cloud"
        else:
            # 否則使用本地引擎（預設 RapidOCR；EasyOCR 為選配）
            print(f"🏠 使用本地 {engine} 進行 OCR 辨識 (Session: {session_id})")
            result_text = await asyncio.to_thread(processor.perform_local_ocr, saved_paths, engine=engine)
            method_name = f"local ({engine})"
            
        return {"session_id": session_id, "text": result_text, "method": method_name}
    except Exception as e:
        print(f"OCR 辨識失敗: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/version")
async def get_version():
    """提供給前端確認服務是否正常，不回傳伺服器本機路徑。"""
    return {
        "version": "3.0-online",
        "timestamp": datetime.now().isoformat(),
        "service": "ai-document-tools"
    }

# ============================================
# API: AI 校稿系統
# ============================================

@app.post("/api/proofread")
async def proofread_files(
    files: List[UploadFile] = File(...),
    api_key: str = Form(None),
    use_word: bool = Form(False),
    use_ckip: bool = Form(False)
):
    """上傳檔案 → 解析 → 本地/雲端校稿 → 回傳結果"""
    session_id = str(uuid.uuid4())
    session_dir = os.path.join(PROOFREAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    all_pages = []
    files_info = []
    allowed_exts = (".pdf", ".doc", ".docx")

    for file in files:
        original_name = safe_upload_filename(file.filename)
        ext = os.path.splitext(original_name)[1].lower()
        if ext not in allowed_exts:
            continue

        file_id = str(uuid.uuid4())
        save_path = os.path.join(session_dir, f"{file_id}{ext}")
        with open(save_path, "wb") as f:
            content = await file.read()
            f.write(content)

        # .doc → .docx 轉換
        actual_path = save_path
        if ext == ".doc":
            try:
                actual_path = await asyncio.to_thread(processor.convert_doc_to_docx, save_path)
            except Exception as e:
                print(f"doc 轉 docx 失敗: {e}")
                continue

        # 解析文件
        pages = await asyncio.to_thread(proofreader.parse_document, actual_path, file_id, original_name)
        all_pages.extend(pages)

        pages_data = [{
            "page": p.page,
            "section": p.section,
            "text": p.text
        } for p in pages]

        files_info.append({
            "id": file_id,
            "filename": original_name,
            "file_path": save_path,
            "page_count": len(pages),
            "pages_json": json.dumps(pages_data, ensure_ascii=False)
        })

    if not files_info:
        raise HTTPException(status_code=400, detail="沒有可分析的有效檔案（僅支援 PDF / Word）")

    # 判斷校稿模式 (完全互斥)
    final_findings = []
    
    if api_key and api_key.strip():
        # 雲端 AI 校稿模式：絕對不執行任何本地校稿規則
        model_used = "gemini"
        try:
            cloud_findings = await asyncio.to_thread(proofreader.cloud_check, all_pages, api_key.strip())
            final_findings = cloud_findings
        except Exception as e:
            print(f"雲端校稿執行失敗: {e}")
            # 依使用者要求，即使 AI 失敗也跳過本地，回傳空結果
    else:
        # 本地規則校稿模式 (整合 Word 與 CKIP)
        model_used = "local_only"
        local_findings = await asyncio.to_thread(
            proofreader.local_check, 
            all_pages, 
            use_word=use_word, 
            use_ckip=use_ckip
        )
        final_findings = local_findings


    # 轉換為字典格式
    findings_dicts = proofreader.findings_to_dicts(final_findings)


    # 生成摘要
    total = len(findings_dicts)
    error_count = sum(1 for f in findings_dicts if f['finding_type'] == 'error')
    consistency_count = sum(1 for f in findings_dicts if f['finding_type'] == 'inconsistency')
    suggestion_count = sum(1 for f in findings_dicts if f['finding_type'] == 'suggestion')
    term_count = sum(1 for f in findings_dicts if f['finding_type'] == 'terminology')
    summary = f"共 {total} 個問題：錯字{error_count}、一致性{consistency_count}、建議{suggestion_count}、術語{term_count}"

    response_data = {
        "session_id": session_id,
        "summary": summary,
        "model_used": model_used,
        "files": files_info,
        "findings": findings_dicts,
        "total_findings": total
    }
    proofread_results[session_id] = response_data
    return response_data


@app.get("/api/proofread/{session_id}")
async def get_proofread_result(session_id: str):
    """取得單筆完整校稿結果"""
    session = proofread_results.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="找不到校稿紀錄")
    return session


@app.get("/api/proofread-export/{session_id}")
async def export_proofread_report(session_id: str):
    """匯出 HTML 校稿報告"""
    session = proofread_results.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="找不到校稿紀錄")

    html = proofreader.generate_html_report(
        session.get('summary', ''),
        session.get('findings', []),
        session.get('files', [])
    )
    return Response(content=html, media_type="text/html",
                    headers={"Content-Disposition": f"attachment; filename=proofread_report_{session_id[:8]}.html"})


# ==========================================
# GIS 空污等濃度圖分析工具 API
# ==========================================

class GisAnalyzeRequest(BaseModel):
    data: list
    method: str = "idw"
    levels_step: float = 0
    colormap: str = "viridis"
    alpha: float = 0.5
    linewidth: float = 1.0
    smooth: bool = True
    pollutant: str = "PM2.5"
    show_fill: bool = True
    line_color: str = "#ff0000"
    show_label: bool = True
    label_size: int = 12
    line_style: str = "solid"
    export_mode: bool = False
    show_north: bool = True

@app.post("/api/gis/analyze")
async def gis_analyze(req: GisAnalyzeRequest):
    try:
        result = await asyncio.to_thread(
            gis_engine.generate_contour,
            data=req.data,
            method=req.method,
            levels_step=req.levels_step,
            colormap=req.colormap,
            alpha=req.alpha,
            linewidth=req.linewidth,
            smooth=req.smooth,
            show_fill=req.show_fill,
            line_color=req.line_color,
            show_label=req.show_label,
            label_size=req.label_size,
            line_style=req.line_style,
            export_mode=req.export_mode,
            show_north=req.show_north
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

class GisAiRequest(BaseModel):
    api_key: str
    data: dict

@app.post("/api/gis/ai-analyze")
async def gis_ai_analyze(req: GisAiRequest):
    try:
        report = await asyncio.to_thread(
            gis_engine.generate_ai_report,
            api_key=req.api_key,
            data=req.data
        )
        return {"status": "success", "report": report}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# --- GIS 專案管理 ---

class GisProjectSaveRequest(BaseModel):
    id: str
    name: str
    data_points: list
    config: dict

@app.post("/api/gis/projects")
async def save_gis_pj(req: GisProjectSaveRequest):
    try:
        database.save_gis_project(req.id, req.name, req.data_points, req.config)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/gis/projects")
async def list_gis_pj():
    projects = database.get_gis_projects()
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] API: 讀取到 {len(projects)} 個 GIS 專案")
    return projects

@app.get("/api/gis/projects/{project_id}")
async def get_gis_pj(project_id: str):
    proj = database.get_gis_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj

@app.delete("/api/gis/projects/{project_id}")
async def delete_gis_pj(project_id: str):
    try:
        database.delete_gis_project(project_id)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/gis/projects/{project_id}/pin")
async def pin_gis_pj(project_id: str):
    try:
        database.toggle_gis_pin(project_id)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))



# ===========================================
# Wind Rose API
# ===========================================
WINDROSE_UPLOAD_DIR = BASE_DIR / "uploads" / "windrose"
WINDROSE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@app.post("/api/windrose/upload-csv")
async def windrose_upload_csv(file: UploadFile = File(...)):
    try:
        content = await file.read()
        csv_text = ""
        for enc in ["utf-8", "big5", "gbk"]:
            try:
                csv_text = content.decode(enc)
                break
            except Exception:
                pass
        if not csv_text:
            csv_text = content.decode("utf-8", errors="replace")
        info = windrose_engine.parse_csv(content)
        return JSONResponse({"ok": True, "csv_text": csv_text, "info": info})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/windrose/compute")
async def windrose_compute(request: Request):
    try:
        import io as _io
        import pandas as _pd
        body = await request.json()
        mode = body.get("mode", "frequency")
        csv_text = body.get("csv_data", "")
        dir_col = body.get("dir_col", "")
        speed_col = body.get("speed_col", "")
        conc_col = body.get("conc_col", "")
        n_dirs = int(body.get("n_dirs", 16))
        speed_bins = body.get("speed_bins", [0, 1, 3, 5, 7, 10])
        speed_labels = body.get("speed_labels", ["低 (0-1)","中 (1-3)","高 (>3)"])
        speed_bins = body.get("speed_bins", [0, 1, 3, 5, 7, 10])
        speed_labels = body.get("speed_labels", ["低 (0-1)","中 (1-3)","高 (>3)"])
        df = _pd.read_csv(_io.StringIO(csv_text), sep=None, engine='python')
        if mode == "frequency":
            result = windrose_engine.compute_frequency_windrose(
                df, dir_col, speed_col, speed_bins, speed_labels, n_dirs)
        else: # mode == "3d_concentration"
            result = windrose_engine.compute_3d_concentration_windrose(
                df, dir_col, speed_col, conc_col, speed_bins, speed_labels, n_dirs)
        return JSONResponse({"ok": True, "data": result, "mode": mode})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/windrose/projects")
async def windrose_list_projects():
    projects = await asyncio.to_thread(windrose_engine.list_projects)
    return JSONResponse({"ok": True, "projects": projects})

@app.post("/api/windrose/projects/save")
async def windrose_save_project(request: Request):
    try:
        body = await request.json()
        pid = windrose_engine.save_project(
            project_id=body.get("id"),
            name=body.get("name", "未命名專案"),
            csv_data=body.get("csv_data", ""),
            settings=body.get("settings", {}),
            description=body.get("description", "")
        )
        return JSONResponse({"ok": True, "id": pid})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/windrose/projects/{project_id}")
async def windrose_load_project(project_id: str):
    project = windrose_engine.load_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="專案不存在")
    return JSONResponse({"ok": True, "project": project})

@app.delete("/api/windrose/projects/{project_id}")
async def windrose_delete_project(project_id: str):
    ok = windrose_engine.delete_project(project_id)
    if not ok:
        raise HTTPException(status_code=404, detail="專案不存在")
    return JSONResponse({"ok": True})






class WindroseAiRequest(BaseModel):
    api_key: str
    data: dict

@app.post("/api/windrose/ai-analyze")
async def windrose_ai_analyze(req: WindroseAiRequest):
    try:
        report = await asyncio.to_thread(
            windrose_engine.generate_ai_report,
            api_key=req.api_key,
            data=req.data
        )
        return {"status": "success", "report": report}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ============================================================
# 相片智能篩選 API
# ============================================================

@app.post("/api/photo-filter/analyze")
async def photo_filter_analyze(
    files: List[UploadFile] = File(...),
    target_face_file: Optional[UploadFile] = File(None),
    blur_threshold: float = Form(80.0),
    min_brightness: float = Form(30.0),
    max_brightness: float = Form(220.0),
    hash_threshold: int = Form(8)
):
    """上傳多張圖片或 ZIP 檔，進行品質分析與分類。可選附帶目標人物圖片進行比對。"""
    if not files:
        raise HTTPException(status_code=400, detail="請至少上傳一個檔案")

    session_id = str(uuid.uuid4())
    session_dir = PHOTO_FILTER_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    
    def add_image_file(filename, content):
        safe_name = safe_upload_filename(filename, f"image_{uuid.uuid4().hex}.bin")
        ext = Path(safe_name).suffix.lower()
        if ext in [".jpg", ".jpeg", ".png", ".bmp", ".webp"]:
            # 忽略系統隱藏檔
            if "__MACOSX" in str(filename) or safe_name.startswith("."):
                return
            dest = session_dir / safe_name
            # 防止檔名衝突
            if dest.exists():
                dest = session_dir / f"{uuid.uuid4().hex[:6]}_{safe_name}"
            dest.write_bytes(content)
            saved_paths.append(str(dest))

    for uf in files:
        upload_name = safe_upload_filename(uf.filename, "upload.bin")
        ext = Path(upload_name).suffix.lower()
        content = await uf.read()
        
        if ext == ".zip":
            # 若為 ZIP 則在記憶體中解壓縮
            try:
                with zipfile.ZipFile(io.BytesIO(content)) as zf:
                    for info in zf.infolist():
                        if not info.is_dir():
                            add_image_file(info.filename, zf.read(info.name))
            except Exception as e:
                print(f"解壓縮 ZIP 失敗 {upload_name}: {e}")
        else:
            add_image_file(upload_name, content)

    if not saved_paths:
        raise HTTPException(status_code=400, detail="沒有可以處理的圖片格式（支援 jpg/png/bmp/webp）")

    # 如果有附帶目標人物照，先把它存下來並提取特徵
    target_feature = None
    if target_face_file and target_face_file.filename:
        # TODO: It could also be named something unique, let's just save it.
        target_name = safe_upload_filename(target_face_file.filename, "target.jpg")
        ext = Path(target_name).suffix.lower()
        if ext in [".jpg", ".jpeg", ".png", ".bmp", ".webp"]:
            tgt_dest = session_dir / f"TARGET_{target_name}"
            tgt_content = await target_face_file.read()
            tgt_dest.write_bytes(tgt_content)
            target_feature = photo_filter_engine.extract_face_feature(str(tgt_dest))

    # 批量分析
    analysis = photo_filter_engine.batch_analyze(saved_paths, target_feature=target_feature)

    # 分類決策
    classified = photo_filter_engine.classify_results(
        analysis,
        blur_threshold=blur_threshold,
        min_brightness=min_brightness,
        max_brightness=max_brightness,
        hash_threshold=hash_threshold
    )

    # 整理回傳格式（移除 path 欄位避免洩漏伺服器路徑）
    output = []
    target_match_count = 0
    for item in classified:
        is_match = item.get("is_target", False)
        if is_match: target_match_count += 1
        output.append({
            "filename": item["filename"],
            "status": item.get("status", "unknown"),
            "reason": item.get("reason", ""),
            "blur_score": item.get("blur_score", 0),
            "brightness": item.get("brightness", 0),
            "contrast": item.get("contrast", 0),
            "has_face": item.get("has_face", False),
            "is_target": is_match,
            "width": item.get("width", 0),
            "height": item.get("height", 0),
            "file_size_kb": item.get("file_size_kb", 0),
            "dup_group": item.get("dup_group", None),
            "phash": item.get("phash", None),
            "error": item.get("error", None)
        })

    summary = {
        "total": len(output),
        "keep": sum(1 for x in output if x["status"] == "keep"),
        "blurry": sum(1 for x in output if x["status"] == "blurry"),
        "exposure": sum(1 for x in output if x["status"] == "exposure"),
        "duplicate": sum(1 for x in output if x["status"] == "duplicate"),
        "target_match": target_match_count,
        "error": sum(1 for x in output if x["status"] == "error"),
        "target_face_detected": (target_feature is not None) if target_face_file else None
    }

    return JSONResponse({"session_id": session_id, "summary": summary, "results": output})


@app.get("/api/photo-filter/thumbnail/{session_id}/{filename}")
async def photo_filter_thumbnail(session_id: str, filename: str):
    """回傳已上傳圖片的縮圖。"""
    root_dir = PHOTO_FILTER_DIR.resolve()
    session_dir = (root_dir / str(session_id)).resolve()
    safe_name = safe_upload_filename(filename, "")
    img_path = (session_dir / safe_name).resolve()
    if session_dir.parent != root_dir or img_path.parent != session_dir or not img_path.exists():
        raise HTTPException(status_code=404, detail="找不到圖片")
    return FileResponse(str(img_path))


@app.post("/api/photo-filter/export-csv")
async def photo_filter_export_csv(payload: dict = Body(...)):
    """將分析結果匯出成 CSV。"""
    results = payload.get("results", [])
    if not results:
        raise HTTPException(status_code=400, detail="沒有可以匯出的資料")

    import io as _io
    import csv

    output = _io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "filename", "status", "reason",
        "blur_score", "brightness", "contrast",
        "has_face", "is_target", "width", "height", "file_size_kb", "dup_group"
    ])
    writer.writeheader()
    for row in results:
        writer.writerow({k: row.get(k, "") for k in writer.fieldnames})

    output.seek(0)
    return Response(
        content=output.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=photo_filter_report.csv"}
    )

@app.post("/api/photo-filter/download-zip")
@app.post("/api/photo-filter/download-zip/")
async def photo_filter_download_zip(payload: dict = Body(...)):
    """將指定的檔案列表打包成 ZIP 下載。"""
    session_id = payload.get("session_id")
    filenames = payload.get("filenames", [])
    filter_label = payload.get("filter_label", "filtered")

    if not session_id or not filenames:
        raise HTTPException(status_code=400, detail="缺少必要參數")

    root_dir = PHOTO_FILTER_DIR.resolve()
    session_dir = (root_dir / str(session_id)).resolve()
    if session_dir.parent != root_dir or not session_dir.exists():
        raise HTTPException(status_code=404, detail="Session 已過期或不存在")

    memory_file = io.BytesIO()
    with zipfile.ZipFile(memory_file, 'w') as zf:
        added_count = 0
        for fname in filenames:
            safe_name = safe_upload_filename(fname, "")
            file_path = (session_dir / safe_name).resolve()
            if safe_name and file_path.parent == session_dir and file_path.exists():
                zf.write(file_path, arcname=safe_name)
                added_count += 1
        
        if added_count == 0:
            raise HTTPException(status_code=400, detail="所選分類下沒有可下載的檔案")

    memory_file.seek(0)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_label = re.sub(r"[^A-Za-z0-9_-]+", "_", str(filter_label))[:40] or "filtered"
    filename = f"photo_{safe_label}_{timestamp}.zip"
    
    return StreamingResponse(
        memory_file,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )
# ===========================================
# 污染來源追蹤系統 API
# ===========================================

_tracker_sessions = {}

@app.post("/api/pollution-tracker/upload-csv")
async def tracker_upload_csv(file: UploadFile = File(...)):
    """上傳 CSV 並解析（含時間欄位偵測）"""
    try:
        content = await file.read()
        csv_text = ""
        for enc in ["utf-8", "big5", "gbk"]:
            try:
                csv_text = content.decode(enc)
                break
            except Exception:
                pass
        if not csv_text:
            csv_text = content.decode("utf-8", errors="replace")
        info = pollution_tracker_engine.parse_csv(content)
        session_id = str(uuid.uuid4())
        _tracker_sessions[session_id] = csv_text
        return JSONResponse({"ok": True, "csv_text": csv_text, "info": info, "session_id": session_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pollution-tracker/trajectories")
async def tracker_trajectories(request: Request):
    """計算逆軌跡"""
    try:
        import io as _io
        import pandas as _pd
        body = await request.json()
        csv_text = body.get("csv_data", "")
        dir_col = body.get("dir_col", "")
        speed_col = body.get("speed_col", "")
        conc_col = body.get("conc_col", "")
        time_col = body.get("time_col", "")
        station_lat = float(body.get("station_lat", 0))
        station_lng = float(body.get("station_lng", 0))
        duration_hours = float(body.get("duration_hours", 1.0))

        df = _pd.read_csv(_io.StringIO(csv_text), sep=None, engine='python')
        df = pollution_tracker_engine.clean_data(df, dir_col, speed_col, conc_col, time_col)

        result = await asyncio.to_thread(
            pollution_tracker_engine.compute_all_trajectories,
            df, dir_col, speed_col, conc_col, time_col,
            station_lat, station_lng, duration_hours
        )
        return JSONResponse({"ok": True, "data": result})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pollution-tracker/heatmap")
async def tracker_heatmap(request: Request):
    """計算熱度圖資料"""
    try:
        import io as _io
        import pandas as _pd
        body = await request.json()
        csv_text = body.get("csv_data", "")
        dir_col = body.get("dir_col", "")
        speed_col = body.get("speed_col", "")
        conc_col = body.get("conc_col", "")
        time_col = body.get("time_col", "")
        station_lat = float(body.get("station_lat", 0))
        station_lng = float(body.get("station_lng", 0))
        duration_hours = float(body.get("duration_hours", 1.0))
        start_time = body.get("start_time")
        end_time = body.get("end_time")

        df = _pd.read_csv(_io.StringIO(csv_text), sep=None, engine='python')
        df = pollution_tracker_engine.clean_data(df, dir_col, speed_col, conc_col, time_col)

        result = await asyncio.to_thread(
            pollution_tracker_engine.compute_heatmap_data,
            df, dir_col, speed_col, conc_col, time_col,
            station_lat, station_lng, duration_hours,
            start_time, end_time
        )
        return JSONResponse({"ok": True, "data": result})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pollution-tracker/detect-events")
async def tracker_detect_events(request: Request):
    """偵測高污染事件"""
    try:
        import io as _io
        import pandas as _pd
        body = await request.json()
        csv_text = body.get("csv_data", "")
        dir_col = body.get("dir_col", "")
        speed_col = body.get("speed_col", "")
        conc_col = body.get("conc_col", "")
        time_col = body.get("time_col", "")
        threshold = body.get("threshold_percentile", 95)

        df = _pd.read_csv(_io.StringIO(csv_text), sep=None, engine='python')
        df = pollution_tracker_engine.clean_data(df, dir_col, speed_col, conc_col, time_col)

        result = pollution_tracker_engine.detect_pollution_events(
            df, time_col, conc_col, dir_col, speed_col, threshold_percentile=threshold
        )
        return JSONResponse({"ok": True, "data": result})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pollution-tracker/twd97-convert")
async def tracker_twd97_convert(request: Request):
    """TWD97 座標轉換為 WGS84"""
    try:
        body = await request.json()
        x = float(body.get("x", 0))
        y = float(body.get("y", 0))
        lon, lat = pollution_tracker_engine.twd97_to_wgs84(x, y)
        return JSONResponse({"ok": True, "lat": lat, "lng": lon})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class TrackerAiRequest(BaseModel):
    api_key: str
    data: dict

@app.post("/api/pollution-tracker/ai-analyze")
async def tracker_ai_analyze(req: TrackerAiRequest):
    try:
        report = await asyncio.to_thread(
            pollution_tracker_engine.generate_ai_report,
            api_key=req.api_key,
            data=req.data
        )
        return {"status": "success", "report": report}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AI 文件工具平台後端伺服器")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="伺服器綁定位址 (127.0.0.1 或 0.0.0.0)")
    parser.add_argument("--port", type=int, default=1700, help="Port to bind to")
    args = parser.parse_args()

    import uvicorn
    # 切換到 backend 目錄，確保路徑相對性一致
    os.chdir(BASE_DIR)
    
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 正在啟動伺服器於 {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
