"""
AI 校稿引擎 (環境工程版)
========================
- parse_document: 結構化解析 PDF / Word
- local_check:    本地規則校稿 (不需 API Key)
- cloud_check:    雲端 Gemini 語意校稿
- merge_findings:  合併 & 去重
"""

import os
import re
import json
import fitz  # PyMuPDF
import docx
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional
import proofing_engines

# 單例引擎快取
_WORD_ENGINE = None
_CKIP_ENGINE = None

def get_word_engine():
    global _WORD_ENGINE
    if _WORD_ENGINE is None:
        _WORD_ENGINE = proofing_engines.WordEngine()
    return _WORD_ENGINE

def get_ckip_engine():
    global _CKIP_ENGINE
    if _CKIP_ENGINE is None:
        # 模型路徑可依需求調整
        _CKIP_ENGINE = proofing_engines.CKIPEngine(model_path="./ckip_models")
    return _CKIP_ENGINE

# ============================================================
# 資料結構
# ============================================================

@dataclass
class PageContent:
    file: str        # 原始檔名
    file_id: str     # 檔案 UUID
    page: int        # 頁碼 (1-based)
    section: str     # 章節/標題 (若有)
    text: str        # 該頁純文字

@dataclass
class Finding:
    file: str
    file_id: str
    page: int
    finding_type: str   # error | inconsistency | suggestion | terminology
    original: str
    suggested: str
    reason: str
    source: str         # local | cloud

# ============================================================
# 1. 文件解析
# ============================================================

def parse_pdf(file_path: str, file_id: str, filename: str) -> List[PageContent]:
    """使用 PyMuPDF 提取 PDF 內嵌文字層 (不做 OCR)"""
    pages = []
    try:
        with fitz.open(file_path) as doc:
            for i, page in enumerate(doc):
                text = page.get_text().strip()
                pages.append(PageContent(
                    file=filename,
                    file_id=file_id,
                    page=i + 1,
                    section="",
                    text=text
                ))
    except Exception as e:
        print(f"PDF 解析失敗 ({filename}): {e}")
    return pages


def parse_word(file_path: str, file_id: str, filename: str) -> List[PageContent]:
    """使用 python-docx 解析 Word 文件，模擬分頁 (每 ~3000 字一頁)"""
    pages = []
    try:
        doc = docx.Document(file_path)
        current_section = ""
        current_text_parts = []
        current_char_count = 0
        page_num = 1
        PAGE_CHAR_LIMIT = 3000

        for para in doc.paragraphs:
            # 偵測標題階層
            if para.style and para.style.name and para.style.name.startswith('Heading'):
                current_section = para.text.strip()

            current_text_parts.append(para.text)
            current_char_count += len(para.text)

            if current_char_count >= PAGE_CHAR_LIMIT:
                pages.append(PageContent(
                    file=filename,
                    file_id=file_id,
                    page=page_num,
                    section=current_section,
                    text="\n".join(current_text_parts)
                ))
                current_text_parts = []
                current_char_count = 0
                page_num += 1

        # 處理剩餘文字
        if current_text_parts:
            pages.append(PageContent(
                file=filename,
                file_id=file_id,
                page=page_num,
                section=current_section,
                text="\n".join(current_text_parts)
            ))

        # 額外提取表格文字，附加到最後一頁
        table_texts = []
        for table in doc.tables:
            for row in table.rows:
                cells = [cell.text.replace("\n", " ").strip() for cell in row.cells]
                table_texts.append(" | ".join(cells))

        if table_texts and pages:
            pages[-1].text += "\n\n[表格內容]\n" + "\n".join(table_texts)

    except Exception as e:
        print(f"Word 解析失敗 ({filename}): {e}")
    return pages


def parse_document(file_path: str, file_id: str, filename: str) -> List[PageContent]:
    """依副檔名分派解析器"""
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".pdf":
        return parse_pdf(file_path, file_id, filename)
    elif ext in (".doc", ".docx"):
        return parse_word(file_path, file_id, filename)
    return []


# ============================================================
# 2. 本地規則校稿
# ============================================================

# --- 環工專業詞庫 ---
ENV_TERMS = {
    # 正確寫法: [常見錯誤寫法列表]
    "COD": ["C.O.D", "c.o.d"],
    "BOD": ["B.O.D", "b.o.d"],
    "BOD₅": ["BOD5", "bod5"],
    "SS": ["S.S", "s.s"],
    "TSS": ["T.S.S"],
    "DO": ["D.O", "d.o"],
    "pH": ["PH", "Ph", "ph值", "PH值"],
    "TN": ["T.N"],
    "TP": ["T.P"],
    "NH₃-N": ["NH3-N", "nh3-n", "NH3N"],
    "mg/L": ["MG/L", "mg/l", "Mg/L", "mg/ L", "mg /L"],
    "μg/L": ["ug/L", "UG/L"],
    "m³/day": ["m3/day", "M3/DAY"],
    "CMD": ["C.M.D"],
    "ppm": ["PPM", "Ppm"],
    "環保署": ["環保暑", "環保属"],
    "廢水": ["废水"],
    "處理": ["処理"],
    "放流水": ["放留水", "放流水水"],
    "活性污泥": ["活性汙泥"],
    "曝氣": ["暴氣", "爆氣", "曝器"],
    "沉澱池": ["沉淀池", "沈澱池"],
    "排放標準": ["排放標凖"],
    "監測": ["監側", "監侧"],
    "採樣": ["采樣"],
    "濃度": ["浓度"],
    "檢測": ["檢側"],
    "汙染": ["污柒", "汙柒"],
    "生態": ["生熊", "生態態"],
    "環境影響評估": ["環境影響評估估", "環境影響評古"],
}

# --- 常見通用錯字 ---
COMMON_TYPOS = {
    "的": ["得", "地"],  # 需要上下文, 先略過
    "已": ["以"],
    "即": ["既"],
    "須": ["需"],  # 「必須」vs「需要」需上下文
    "哪": ["那"],  # 需上下文
    "其": ["期"],
    "依據": ["依據據"],
    "規範": ["規範範"],
}

# --- 標點符號規則 ---
PUNCTUATION_RULES = [
    (r'[,;:!?]', '偵測到半形標點符號，建議使用全形標點'),
    (r'[。]{2,}', '連續句號'),
    (r'[，]{2,}', '連續逗號'),
    (r'[、]{3,}', '過多頓號'),
]


def _check_env_terms(text: str, page: PageContent) -> List[Finding]:
    """檢查環工專業術語拼寫"""
    findings = []
    for correct, wrongs in ENV_TERMS.items():
        for wrong in wrongs:
            # 使用不區分大小寫的精確匹配 (做 word boundary 避免誤報)
            pattern = re.compile(re.escape(wrong))
            for match in pattern.finditer(text):
                # 取得上下文 (前後 15 字)
                start = max(0, match.start() - 15)
                end = min(len(text), match.end() + 15)
                context = text[start:end].replace("\n", " ")
                findings.append(Finding(
                    file=page.file,
                    file_id=page.file_id,
                    page=page.page,
                    finding_type="terminology",
                    original=match.group(),
                    suggested=correct,
                    reason=f"環工專業術語應寫為「{correct}」，原文「...{context}...」",
                    source="local"
                ))
    return findings


def _check_punctuation(text: str, page: PageContent) -> List[Finding]:
    """檢查標點符號問題"""
    findings = []
    for pattern_str, desc in PUNCTUATION_RULES:
        for match in re.finditer(pattern_str, text):
            start = max(0, match.start() - 10)
            end = min(len(text), match.end() + 10)
            context = text[start:end].replace("\n", " ")
            findings.append(Finding(
                file=page.file,
                file_id=page.file_id,
                page=page.page,
                finding_type="error",
                original=match.group(),
                suggested="（請改用全形標點）" if "半形" in desc else "（請修正）",
                reason=f"{desc}。原文「...{context}...」",
                source="local"
            ))
    return findings


def _check_data_consistency(all_pages: List[PageContent]) -> List[Finding]:
    """跨頁/跨檔數據一致性檢查：提取數值與單位，比對前後文"""
    findings = []
    # 提取 "數字 + 單位" 的 pattern
    num_unit_pattern = re.compile(
        r'(\d+(?:\.\d+)?)\s*(mg/L|μg/L|m³/day|CMD|ppm|%|噸|公升|公頃|公尺|萬元|億元|人次)',
        re.IGNORECASE
    )

    # 收集所有提及的數據
    data_mentions: Dict[str, List] = {}  # key: "值+單位" -> [{page, file, context}]

    for page in all_pages:
        for match in num_unit_pattern.finditer(page.text):
            value = match.group(1)
            unit = match.group(2)
            key = f"{unit.lower()}"

            start = max(0, match.start() - 30)
            end = min(len(page.text), match.end() + 30)
            context = page.text[start:end].replace("\n", " ").strip()

            if key not in data_mentions:
                data_mentions[key] = []
            data_mentions[key].append({
                "value": value,
                "unit": unit,
                "page": page.page,
                "file": page.file,
                "file_id": page.file_id,
                "context": context
            })

    # 檢查同一指標在不同位置是否出現不同數值 (簡易版)
    for unit_key, mentions in data_mentions.items():
        if len(mentions) < 2:
            continue
        values = set(m["value"] for m in mentions)
        if len(values) > 1:
            # 有不同數值，可能是前後不一致
            first = mentions[0]
            for other in mentions[1:]:
                if other["value"] != first["value"]:
                    findings.append(Finding(
                        file=other["file"],
                        file_id=other["file_id"],
                        page=other["page"],
                        finding_type="inconsistency",
                        original=f"{other['value']} {other['unit']}",
                        suggested=f"請確認是否應為 {first['value']} {first['unit']}",
                        reason=f"同一指標「{unit_key}」在 {first['file']} 第{first['page']}頁為 {first['value']}，此處為 {other['value']}，可能前後矛盾。",
                        source="local"
                    ))
    return findings


def _check_figure_table_refs(all_pages: List[PageContent]) -> List[Finding]:
    """檢查圖/表編號的引用一致性"""
    findings = []
    fig_pattern = re.compile(r'圖\s*(\d+[-.]?\d*)')
    tbl_pattern = re.compile(r'表\s*(\d+[-.]?\d*)')

    fig_refs = set()
    tbl_refs = set()

    for page in all_pages:
        for m in fig_pattern.finditer(page.text):
            fig_refs.add(m.group(1))
        for m in tbl_pattern.finditer(page.text):
            tbl_refs.add(m.group(1))

    # 檢查編號是否連續 (簡易：只檢查整數編號)
    for label, refs in [("圖", fig_refs), ("表", tbl_refs)]:
        int_refs = sorted([int(r) for r in refs if r.isdigit()])
        if len(int_refs) >= 2:
            for i in range(len(int_refs) - 1):
                if int_refs[i + 1] - int_refs[i] > 1:
                    missing = int_refs[i] + 1
                    findings.append(Finding(
                        file=all_pages[0].file,
                        file_id=all_pages[0].file_id,
                        page=1,
                        finding_type="inconsistency",
                        original=f"{label}{int_refs[i]} → {label}{int_refs[i+1]}",
                        suggested=f"缺少{label}{missing}的引用",
                        reason=f"文中引用了{label}{int_refs[i]}與{label}{int_refs[i+1]}，但未提及{label}{missing}，可能漏引或編號跳號。",
                        source="local"
                    ))
    return findings


def local_check(all_pages: List[PageContent], use_word: bool = False, use_ckip: bool = False) -> List[Finding]:
    """本地規則校稿主函數"""
    findings = []
    
    # 初始化引擎 (若有選用)
    word_engine = get_word_engine() if use_word else None
    ckip_engine = get_ckip_engine() if use_ckip else None

    for page in all_pages:
        if not page.text.strip():
            continue
            
        # 1. 舊有規則檢查
        findings.extend(_check_env_terms(page.text, page))
        findings.extend(_check_punctuation(page.text, page))
        
        # 2. Microsoft Word 校訂 (若選用)
        if word_engine:
            word_res = word_engine.check_text(page.text)
            for r in word_res:
                findings.append(Finding(
                    file=page.file, file_id=page.file_id, page=page.page,
                    finding_type=r["finding_type"], original=r["original"],
                    suggested=r["suggested"], reason=r["reason"], source="word"
                ))

        # 3. CKIP 斷詞偵測 (若選用)
        if ckip_engine:
            ckip_res = ckip_engine.check_text(page.text)
            for r in ckip_res:
                findings.append(Finding(
                    file=page.file, file_id=page.file_id, page=page.page,
                    finding_type=r["finding_type"], original=r["original"],
                    suggested=r["suggested"], reason=r["reason"], source="ckip"
                ))

    # 跨頁 / 跨檔分析
    findings.extend(_check_data_consistency(all_pages))
    findings.extend(_check_figure_table_refs(all_pages))
    return findings


# ============================================================
# 3. 雲端 AI 語意校稿
# ============================================================

def cloud_check(all_pages: List[PageContent], api_key: str) -> List[Finding]:
    """使用 Gemini 進行語意層面校稿 (同步版本，在 asyncio.to_thread 中呼叫)"""
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    findings = []

    # 組合文字 (每頁標示頁碼)
    combined = []
    file_id_map = {}  # filename -> file_id
    for p in all_pages:
        file_id_map[p.file] = p.file_id
        combined.append(f"=== 檔案：{p.file} | 第{p.page}頁 ===\n{p.text}")

    full_text = "\n\n".join(combined)
    if len(full_text) < 50:
        return findings

    prompt = """你是一位專業的 AI 繁體中文校對與環境工程稽核專家。
任務：進行「地毯式搜索」，嚴格找出所有問題：

1. 錯字、漏字、標點符號錯誤
2. 語句不通順、冗詞贅字
3. 前後用詞與數據不一致（跨頁、跨檔比對）
4. 圖表編號 vs 內文引用不一致
5. 環境工程專業術語使用錯誤（COD/BOD/SS/pH/mg/L 等）

【重要原則：避免過度校對】
- 僅報告實質性的錯誤（錯字、邏輯矛盾、術語錯誤、明顯數據錯誤）。
- 若僅是「半形空格增減」、「全半形空白差異」或「字元間距」，視為排版誤差，請絕對不要回報。
- 在內文引用圖表時（如：表3.1.2-4 農業...表），除非編號數字錯誤，否則請保留使用者原有的標題引用樣式，不要建議移除標題文字。
- 請在每筆 reason 中標註來源的「檔案名稱」和「頁碼」


【回傳格式】
僅回傳 JSON：
{
    "findings": [
        {
            "file": "來源檔案名稱",
            "page": 頁碼數字,
            "type": "error|inconsistency|suggestion|terminology",
            "original": "具體的錯誤原文",
            "suggested": "修正後的內容",
            "reason": "具體的錯誤原因"
        }
    ]
}"""

    try:
        # 動態尋找模型
        raw_models = genai.list_models()
        all_models = [m.name for m in raw_models
                      if 'generateContent' in m.supported_generation_methods
                      and 'gemini' in m.name.lower()]

        BLOCKED = ["tts", "embedding", "aqa", "attribution"]
        text_models = [m for m in all_models if not any(kw in m.lower() for kw in BLOCKED)]
        modern = [m for m in text_models if any(v in m.lower() for v in ["1.5", "2.0", "2.5", "exp", "flash"])]
        available = modern if modern else text_models

        if not available:
            return findings

        def rank(name):
            n = name.lower()
            s = 0
            if "2.5" in n: s += 3000
            if "2.0" in n: s += 2000
            if "1.5" in n: s += 1000
            if "pro" in n: s += 500
            if "flash" in n: s += 200
            if "exp" in n: s += 50
            return s

        model_names = sorted(available, key=rank, reverse=True)
        model_used = "unknown"

        for m_name in model_names:
            try:
                print(f"🔄 校稿：嘗試模型 {m_name}")
                model = genai.GenerativeModel(m_name)
                gen_cfg = {"response_mime_type": "application/json"} if any(
                    v in m_name for v in ["1.5", "2.0", "exp"]) else None

                response = model.generate_content(
                    [prompt, f"以下是完整的文件內容：\n\n{full_text}"],
                    generation_config=gen_cfg
                )

                if not response.parts:
                    continue

                res_text = response.text
                if "```json" in res_text:
                    res_text = res_text.split("```json")[1].split("```")[0].strip()
                elif "```" in res_text:
                    res_text = res_text.split("```")[1].split("```")[0].strip()

                parsed = json.loads(res_text, strict=False)
                model_used = m_name

                for f in parsed.get("findings", []):
                    origin_raw = str(f.get("original", "")).strip()
                    suggest_raw = str(f.get("suggested", "")).strip()
                    
                    # 深度過濾：移除所有空白後比對，若一致則視為偽錯誤
                    origin_norm = re.sub(r'\s+', '', origin_raw).lower()
                    suggest_norm = re.sub(r'\s+', '', suggest_raw).lower()
                    
                    if not origin_raw or not suggest_raw or origin_norm == suggest_norm:
                        continue
                        
                    fname = f.get("file", all_pages[0].file if all_pages else "")
                    fid = file_id_map.get(fname, "")

                    findings.append(Finding(
                        file=fname,
                        file_id=fid,
                        page=int(f.get("page", 1)),
                        finding_type=f.get("type", "suggestion"),
                        original=f.get("original", ""),
                        suggested=f.get("suggested", ""),
                        reason=f.get("reason", ""),
                        source="cloud"
                    ))

                print(f"✅ 校稿使用模型 {m_name} 成功！共 {len(findings)} 筆")
                break  # 成功就跳出

            except Exception as e:
                err = str(e).lower()
                if "429" in err or "quota" in err or "503" in err or "overloaded" in err:
                    print(f"⚠️ 模型 {m_name} 受限，切換下一個...")
                    continue
                else:
                    print(f"⚠️ 模型 {m_name} 錯誤: {e}")
                    break

    except Exception as e:
        print(f"雲端校稿引擎初始化失敗: {e}")

    return findings


# ============================================================
# 4. 結果合併 & 去重
# ============================================================

def merge_findings(local_findings: List[Finding], cloud_findings: List[Finding]) -> List[Finding]:
    """合併本地+雲端結果，去除高度相似的重複項，按頁碼排序"""
    merged = list(local_findings)

    for cf in cloud_findings:
        # 簡單去重：如果同頁 + 原文片段重疊 > 50% → 視為重複
        is_dup = False
        for lf in local_findings:
            if lf.page == cf.page and lf.file == cf.file:
                # 取較短的原文做比對
                shorter = min(lf.original, cf.original, key=len)
                longer = max(lf.original, cf.original, key=len)
                if shorter and shorter in longer:
                    is_dup = True
                    break
        if not is_dup:
            merged.append(cf)

    # 按檔案 → 頁碼排序
    merged.sort(key=lambda f: (f.file, f.page))
    return merged


def findings_to_dicts(findings: List[Finding]) -> List[dict]:
    """轉換為可 JSON 序列化的字典列表"""
    return [asdict(f) for f in findings]


def generate_html_report(session_summary: str, findings: List[dict], files: List[dict]) -> str:
    """產生可匯出的 HTML 校稿報告"""

    type_labels = {
        "error": "❌ 錯字/漏字",
        "inconsistency": "⚠️ 一致性問題",
        "suggestion": "💡 語句建議",
        "terminology": "🔬 專業術語",
    }
    type_colors = {
        "error": "#ff5252",
        "inconsistency": "#ffd740",
        "suggestion": "#448aff",
        "terminology": "#b388ff",
    }

    rows = ""
    for i, f in enumerate(findings, 1):
        t = f.get("finding_type", "error")
        color = type_colors.get(t, "#999")
        label = type_labels.get(t, t)
        rows += f"""
        <tr>
            <td>{i}</td>
            <td>{f.get('file','')}</td>
            <td>P.{f.get('page','')}</td>
            <td><span style="color:{color};font-weight:600">{label}</span></td>
            <td style="color:#ff5252">{f.get('original','')}</td>
            <td style="color:#4caf50">{f.get('suggested','')}</td>
            <td>{f.get('reason','')}</td>
            <td>{f.get('source','')}</td>
        </tr>"""

    file_list = ", ".join([f.get("filename", "") for f in files])

    return f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>AI 校稿報告</title>
<style>
body {{ font-family: 'Inter', system-ui, sans-serif; background: #1a1a2e; color: #eee; padding: 2rem; }}
h1 {{ text-align: center; color: #00d2ff; margin-bottom: 0.5rem; }}
.meta {{ text-align: center; color: #aaa; margin-bottom: 2rem; }}
table {{ width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.05); border-radius: 12px; overflow: hidden; }}
th {{ background: rgba(0,210,255,0.15); color: #00d2ff; padding: 12px; text-align: left; font-size: 0.9rem; }}
td {{ padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem; line-height: 1.5; }}
tr:hover {{ background: rgba(255,255,255,0.03); }}
.summary {{ background: rgba(0,210,255,0.08); border: 1px solid rgba(0,210,255,0.2); border-radius: 12px; padding: 1.5rem; margin-bottom: 2rem; text-align: center; }}
</style>
</head>
<body>
<h1>📝 AI 校稿報告</h1>
<p class="meta">檔案：{file_list} | 共 {len(findings)} 筆問題</p>
<div class="summary"><strong>摘要：</strong>{session_summary}</div>
<table>
<thead><tr><th>#</th><th>檔案</th><th>頁碼</th><th>類型</th><th>原文</th><th>建議修改</th><th>說明</th><th>來源</th></tr></thead>
<tbody>{rows}</tbody>
</table>
<p style="text-align:center;margin-top:2rem;color:#666">AI 文件工具平台 - 校稿報告 | 自動產生</p>
</body></html>"""
