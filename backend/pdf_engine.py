from pypdf import PdfReader, PdfWriter
from pypdf.errors import FileNotDecryptedError
import io
import logging
import fitz  # PyMuPDF
import zipfile
import os

logger = logging.getLogger(__name__)

def unlock_pdf(file_bytes: bytes, filename: str) -> bytes:
    """
    嘗試解密並回傳解鎖後的 PDF byte 陣列。
    如果無法以空密碼解密，代表使用了「開啟密碼 / 擁有者強制加密」，會拋出異常。
    """
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        is_encrypted = reader.is_encrypted

        if is_encrypted:
            # 嘗試使用空密碼解開「複製/列印限制 (Owner Password)」
            success = reader.decrypt("")
            if not success:
               raise ValueError("此 PDF 使用了強大的「開啟密碼」或「高強度加密」。本平台僅支援解除「禁止複製、列印」等權限限制，無法破解未知的開啟密碼。")

        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        out_stream = io.BytesIO()
        writer.write(out_stream)
        return out_stream.getvalue()

    except ValueError as ve:
        raise ve
    except Exception as e:
        logger.error(f"PDF 處理失敗 {filename}: {e}")
        raise ValueError(f"處理 PDF 發生異常，檔案可能已損毀或無法辨識。錯誤代碼: {str(e)}")

def pdf_to_images(file_bytes: bytes, filename: str, fmt: str = "png", dpi: int = 300) -> bytes:
    """
    將 PDF 轉換為圖片。
    如果只有一頁，回傳該圖片的 bytes。
    如果有多頁，回傳包含所有圖片的 ZIP bytes。
    """
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        images = []
        
        # 設定縮放倍率 (DPI 轉換)
        # 預設 72 DPI，所以 scale = dpi / 72
        scale = dpi / 72
        matrix = fitz.Matrix(scale, scale)
        
        for i in range(len(doc)):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB)
            
            img_data = pix.tobytes(fmt)
            images.append((f"{os.path.splitext(filename)[0]}_{i+1}.{fmt}", img_data))
            
        doc.close()
        
        if not images:
            raise ValueError("PDF 沒有可轉換的頁面")
            
        # 如果只有一頁且不是要 ZIP，可以直接回傳 (但為了 API 一致性，通常建議統一或根據需求)
        # 這裡我們選擇：多於一頁必打包 ZIP，一頁則看呼叫端需求。
        # 為了簡化前端處理，我們讓後端在多頁時自動打包。
        
        if len(images) == 1:
            return images[0][1], images[0][0], False # bytes, filename, is_zip
        else:
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w") as zf:
                for img_name, img_bytes in images:
                    zf.writestr(img_name, img_bytes)
            return zip_buffer.getvalue(), f"{os.path.splitext(filename)[0]}_images.zip", True

    except Exception as e:
        logger.error(f"PDF 轉圖片失敗 {filename}: {e}")
        raise ValueError(f"轉換 PDF 為圖片時發生錯誤: {str(e)}")
