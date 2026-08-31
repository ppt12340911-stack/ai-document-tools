import os
import re
import sys
import threading
from typing import List, Dict, Any

# 嘗試匯入必要的庫，若無則在執行時報錯
try:
    import win32com.client as win32
    import pythoncom
except ImportError:
    win32 = None

try:
    from ckiptagger import WS
except ImportError:
    WS = None

# ============================================================
# 1. Microsoft Word 引擎
# ============================================================

class WordEngine:
    """利用本地端 Microsoft Word 進行拼字與語法檢查"""
    
    def __init__(self):
        self.word_app = None
        self._lock = threading.Lock()

    def _ensure_word(self):
        if self.word_app is None:
            pythoncom.CoInitialize()
            try:
                # 嘗試連接已開啟的 Word 或啟動新的
                self.word_app = win32.gencache.EnsureDispatch('Word.Application')
                self.word_app.Visible = False
                self.word_app.DisplayAlerts = False
            except Exception as e:
                print(f"無法啟動 Microsoft Word: {e}")
                raise e

    def check_text(self, text: str) -> List[Dict[str, Any]]:
        """檢查一段文字並回傳錯誤清單"""
        if not win32:
            return []
            
        findings = []
        if not text.strip():
            return findings

        with self._lock:
            try:
                self._ensure_word()
                doc = self.word_app.Documents.Add()
                doc.Content.Text = text
                
                # 1. 拼字檢查 (Spelling Errors)
                for err in doc.SpellingErrors:
                    findings.append({
                        "finding_type": "error",
                        "original": err.Text,
                        "suggested": "（參考 Word 拼字修訂）",
                        "reason": "Microsoft Word 偵測到疑似拼字錯誤。",
                        "source": "word_spelling"
                    })
                
                # 2. 語法檢查 (Grammar Errors)
                for err in doc.GrammarErrors:
                    findings.append({
                        "finding_type": "suggestion",
                        "original": err.Text,
                        "suggested": "（參考 Word 語句修訂）",
                        "reason": "Microsoft Word 偵測到語法不通順或錯誤。",
                        "source": "word_grammar"
                    })
                
                doc.Close(SaveChanges=False)
            except Exception as e:
                print(f"Word 校稿執行失敗: {e}")
            
        return findings

    def close(self):
        if self.word_app:
            try:
                self.word_app.Quit()
                self.word_app = None
            except:
                pass

# ============================================================
# 2. CKIP 斷詞偵測引擎
# ============================================================

class CKIPEngine:
    """利用中研院 CKIP 斷詞系統偵測潛在錯字"""
    
    def __init__(self, model_path: str = "./ckip_models"):
        self.model_path = model_path
        self.ws = None
        self._lock = threading.Lock()

    def _ensure_model(self):
        """檢查並載入模型"""
        if self.ws is None:
            if not os.path.exists(self.model_path):
                print("CKIP 模型不存在，準備下載...")
                # 這裡可以加入自動下載邏輯，或提示使用者
                from ckiptagger import data_utils
                data_utils.download_data_url(self.model_path) 
            
            try:
                # 載入 WS 模型 (僅載入 WS 以節省資源)
                self.ws = WS(self.model_path)
            except Exception as e:
                print(f"CKIP 模型載入失敗: {e}")
                raise e

    def check_text(self, text: str) -> List[Dict[str, Any]]:
        """分析文字斷詞，找出疑似碎裂（錯字造成）的片段"""
        if not WS:
            return []
            
        findings = []
        # 去除換行以利斷詞
        clean_text = text.replace("\n", " ").strip()
        if len(clean_text) < 2:
            return findings

        with self._lock:
            try:
                self._ensure_model()
                # 執行斷詞
                word_sentence_list = self.ws([clean_text])
                words = word_sentence_list[0]
                
                # 偵測邏輯：若出現連續多個單字（長度1），且不屬於常用字組合，則可能代表中間有錯字導致斷詞碎裂
                fragment_count = 0
                temp_fragment = []
                
                for word in words:
                    if len(word) == 1 and bool(re.match(r'[\u4e00-\u9fa5]', word)):
                        fragment_count += 1
                        temp_fragment.append(word)
                    else:
                        if fragment_count >= 4:
                            # 發現疑似碎裂片段
                            frag_str = "".join(temp_fragment)
                            findings.append({
                                "finding_type": "error",
                                "original": frag_str,
                                "suggested": "（請確認詞彙完整性）",
                                "reason": "CKIP 偵測到斷詞異常碎裂，此處可能有錯字或罕見詞彙。",
                                "source": "ckip_tagger"
                            })
                        fragment_count = 0
                        temp_fragment = []
                
                # 處理結尾
                if fragment_count >= 4:
                    frag_str = "".join(temp_fragment)
                    findings.append({
                        "finding_type": "error",
                        "original": frag_str,
                        "suggested": "（請確認詞彙完整性）",
                        "reason": "CKIP 偵測到斷詞異常碎裂，此處可能有錯字或罕見詞彙。",
                        "source": "ckip_tagger"
                    })
                    
            except Exception as e:
                print(f"CKIP 校稿執行失敗: {e}")
                
        return findings
