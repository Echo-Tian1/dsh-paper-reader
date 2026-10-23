#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文献阅读坞 · PDF 抽取器（宿主半）

用法：
    python3 extract.py <source.pdf> <outDir>                  # 全量抽取
    python3 extract.py --region <pdf> <page> <x0,y0,x1,y1>    # 框选区域（吸附 + 行级重建；扫描页自动视觉 OCR）
    python3 extract.py --links-only <pdf> <outDir>            # 只回填 links.json（老文档惰性重建用）

产物：
    <outDir>/structure.json      章节 / 段落 / 句子区间 / 页元数据（最后写，失败时不留“完整”假象）
    <outDir>/links.json          PDF 链接（内部跳转 goto / 外链 uri），归一化后逐页列出
    <outDir>/pages/<n>.json      该页逐词坐标 [[x0,y0,x1,y1,word,paraId], ...]
    <outDir>/pages/<n>.png       该页 1.5x 渲染图（/media 路由直接读这里）

stdout 只输出一行 JSON 摘要；失败时输出 {"ok":false,"code":...,"message":...} 并以非零码退出。

坐标系：PDF 点（1/72 英寸），原点左上，与 get_text('words') 一致。
段落合并 / 切句 / 章节都是启发式（CONTRACT 与设计文档已注明），边界可能偏；
解释请求始终携带整段与相邻段上下文来降低误伤。
"""

import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import traceback

try:
    import fitz  # PyMuPDF
except Exception as exc:  # pragma: no cover - 只在环境缺依赖时触发
    print(json.dumps({
        "ok": False,
        "code": "py-error",
        "message": "Python 找不到 PyMuPDF（import fitz 失败）：%s" % exc,
    }, ensure_ascii=False))
    sys.exit(2)

LATIN_END = ".!?"
CJK_END = "。！？；"
CLOSERS = "\"'”’»)]）】」』"
# 拉丁缩写保护表（点号前的词干，小写）
ABBREVIATIONS = {
    "al", "fig", "figs", "eq", "eqs", "no", "nos", "vs", "e.g", "i.e", "cf",
    "sec", "tab", "ref", "refs", "approx", "dr", "mr", "ms", "mrs", "prof",
    "inc", "ltd", "co", "etc", "resp", "vol", "pp", "ch", "ed", "eds", "st",
}
BULLET_RE = re.compile(r"^[\s•·●▪◦‣⁃*\-–—]+")
PAGE_NUMBER_RE = re.compile(r"^\d{1,4}$")
NUMBERED_HEADING_RE = re.compile(r"^\s*\d+(?:\.\d+)*\s+\S")


def fail(code, message, exit_code=2):
    """输出一行失败摘要并以非零码退出。"""
    print(json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(exit_code)


def is_cjk(char):
    """是否为 CJK 字符（含中文/全角标点）。"""
    if not char:
        return False
    code = ord(char)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0x3000 <= code <= 0x303F
        or 0xFF00 <= code <= 0xFFEF
        or 0x3040 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
    )


def needs_space(left, right):
    """拼接两段文本时是否需要补空格：CJK 之间不加，拉丁文之间加。"""
    if not left or not right:
        return False
    if left in "-/(" or right in "),.;:!?]":
        return False
    return not is_cjk(left) and not is_cjk(right)


def join_piece(text, piece):
    """把一行/一块文本拼到已有文本末尾，处理连字符断行与 CJK。"""
    if not piece:
        return text
    if not text:
        return piece
    if text.endswith("-") and len(text) > 1 and piece[0].islower():
        # 行尾连字符断行还原：transduc- / tion -> transduction
        return text[:-1] + piece
    if needs_space(text[-1], piece[0]):
        return text + " " + piece
    return text + piece


def span_is_bold(span):
    """粗体判定：PyMuPDF flags 第 4 位，或字体名带 Bold/Medi/Heavy/Black。"""
    flags = int(span.get("flags") or 0)
    if flags & 16:
        return True
    font = str(span.get("font") or "")
    return any(token in font for token in ("Bold", "Medi", "Heavy", "Black", "Demi"))


def median(values, default=0.0):
    """安全中位数。"""
    values = [value for value in values if value is not None]
    if not values:
        return default
    return statistics.median(values)


class TextBlock(object):
    """一页内的一个文本块（get_text('dict') 的 type=0 block）。"""

    __slots__ = ("number", "bbox", "text", "heading", "rotated", "footer",
                 "line_height", "width", "height", "col")

    def __init__(self, number, bbox, text, heading, rotated, line_height):
        self.number = number
        self.bbox = bbox
        self.text = text
        self.heading = heading
        self.rotated = rotated
        self.footer = False
        self.line_height = line_height
        self.width = bbox[2] - bbox[0]
        self.height = bbox[3] - bbox[1]
        self.col = 0


def read_block(block, body_size):
    """把一个 dict block 解析成 TextBlock；空文本返回 None。"""
    lines = block.get("lines") or []
    if not lines:
        return None
    spans = []
    line_texts = []
    line_heights = []
    rotated = 0
    horizontal = 0
    for line in lines:
        direction = line.get("dir") or (1, 0)
        if abs(direction[0] - 1) < 1e-3 and abs(direction[1]) < 1e-3:
            horizontal += 1
        else:
            rotated += 1
        line_spans = line.get("spans") or []
        spans.extend(line_spans)
        line_texts.append("".join(span.get("text") or "" for span in line_spans))
        bbox = line.get("bbox")
        if bbox:
            line_heights.append(max(0.1, bbox[3] - bbox[1]))
    if not spans:
        return None
    text = ""
    for line_text in line_texts:
        text = join_piece(text, line_text.strip())
    text = text.strip()
    if not text:
        return None
    bold_count = sum(1 for span in spans if span_is_bold(span))
    bold_ratio = bold_count / float(len(spans))
    max_size = max(float(span.get("size") or 0) for span in spans)
    heading = (bold_ratio >= 0.5) or (body_size > 0 and max_size >= body_size * 1.15)
    bbox = block.get("bbox") or (0, 0, 0, 0)
    return TextBlock(
        number=block.get("number"),
        bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
        text=text,
        heading=heading,
        rotated=rotated > horizontal,
        line_height=median(line_heights, max(1.0, float(bbox[3]) - float(bbox[1]))),
    )


def detect_columns(blocks, page_width):
    """判定单栏/双栏：只看窄块（宽 < 0.6 页宽）作为栏证据，满宽块不参与聚类。"""
    narrow = [block for block in blocks if block.width < 0.6 * page_width]
    if len(narrow) < 4:
        return "one", None
    xs = sorted(block.bbox[0] for block in narrow)
    clusters = [[xs[0]]]
    for x in xs[1:]:
        if x - clusters[-1][-1] > 0.08 * page_width:
            clusters.append([x])
        else:
            clusters[-1].append(x)
    if len(clusters) != 2:
        return "one", None
    split = (max(clusters[0]) + min(clusters[1])) / 2.0
    left = [block for block in narrow if block.bbox[0] < split]
    right = [block for block in narrow if block.bbox[0] >= split]
    if len(left) < 2 or len(right) < 2:
        return "one", None
    if max(block.bbox[2] for block in left) >= min(block.bbox[0] for block in right) - 1:
        return "one", None
    return "two", split


def order_blocks(blocks, page_width):
    """把块排成阅读顺序：单栏按 y；双栏按「满宽块分带 + 左栏→右栏」。"""
    columns, split = detect_columns(blocks, page_width)
    if columns == "one":
        ordered = sorted(blocks, key=lambda block: (round(block.bbox[1], 1), block.bbox[0]))
        for block in ordered:
            block.col = 0
        return ordered, columns

    def narrow_order(items):
        left = sorted([b for b in items if b.bbox[0] < split], key=lambda b: (b.bbox[1], b.bbox[0]))
        right = sorted([b for b in items if b.bbox[0] >= split], key=lambda b: (b.bbox[1], b.bbox[0]))
        for block in left:
            block.col = 0
        for block in right:
            block.col = 1
        return left + right

    full = [block for block in blocks if block.width >= 0.6 * page_width]
    narrow = [block for block in blocks if block.width < 0.6 * page_width]
    for block in full:
        block.col = None  # 满宽块不参与段落合并
    ordered = []
    remaining = list(narrow)
    for wide in sorted(full, key=lambda b: (b.bbox[1], b.bbox[0])):
        before = [block for block in remaining if block.bbox[1] < wide.bbox[1] - 1]
        before_ids = set(id(block) for block in before)
        ordered.extend(narrow_order(before))
        remaining = [block for block in remaining if id(block) not in before_ids]
        ordered.append(wide)
    ordered.extend(narrow_order(remaining))
    return ordered, columns


def sentence_end(text):
    """文本是否以句末标点结束（判断段落是否续写）。"""
    return bool(re.search(r"[.!?。！？；]\s*[\"'”’)\]]*$", text or ""))


def is_protected_dot(text, index):
    """点号是否属于缩写 / 小数 / URL，而不是句末。"""
    length = len(text)
    if index + 1 < length and text[index + 1] == ".":
        return True
    if index > 0 and text[index - 1] == ".":
        return True
    if 0 < index < length - 1 and text[index - 1].isdigit() and text[index + 1].isdigit():
        return True
    token_start = index
    while token_start > 0 and not text[token_start - 1].isspace():
        token_start -= 1
    token_end = index
    while token_end < length and not text[token_end].isspace():
        token_end += 1
    token = text[token_start:token_end]
    if "://" in token or "www." in token or re.search(r"\.(com|org|net|edu|gov|io|ai)(/|$)", token):
        return True
    match = re.search(r"([A-Za-z][A-Za-z.]*)$", text[:index])
    if not match:
        return False
    word = match.group(1).lower().rstrip(".")
    if word in ABBREVIATIONS:
        return True
    raw = match.group(1)
    if len(raw) == 1 and raw.isupper():
        return True
    return False


def split_sentences(text):
    """把段落切成段内字符区间 [[start,end), ...]；必须首尾相接覆盖全文。"""
    if not text:
        return []
    length = len(text)
    ranges = []
    start = 0
    index = 0
    while index < length:
        char = text[index]
        if char in CJK_END:
            end = index + 1
            while end < length and text[end] in CLOSERS:
                end += 1
            ranges.append((start, end))
            start = end
            index = end
            continue
        if char in LATIN_END:
            if char == "." and is_protected_dot(text, index):
                index += 1
                continue
            end = index + 1
            while end < length and text[end] in CLOSERS:
                end += 1
            if end >= length or text[end].isspace():
                ranges.append((start, end))
                start = end
                index = end
                continue
        index += 1
    if start < length:
        ranges.append((start, length))

    cleaned = []
    for item in ranges:
        if item[1] <= item[0]:
            continue
        if not text[item[0]:item[1]].strip():
            if cleaned:
                cleaned[-1] = (cleaned[-1][0], item[1])
            continue
        cleaned.append(item)
    if len(cleaned) > 1 and cleaned[-1][1] - cleaned[-1][0] < 2:
        cleaned[-2] = (cleaned[-2][0], cleaned[-1][1])
        cleaned.pop()
    if not cleaned:
        cleaned = [(0, length)]
    # 首尾空白也落在句区间里，保证区间首尾相接、完整覆盖 text
    cleaned[0] = (0, cleaned[0][1])
    cleaned[-1] = (cleaned[-1][0], length)
    return [[int(item[0]), int(item[1])] for item in cleaned]


def merge_blocks(ordered):
    """把阅读顺序相邻的块合并成段落（启发式 v1）。"""
    paragraphs = []
    current = None
    for block in ordered:
        mergeable = False
        if current is not None:
            tail = current["blocks"][-1]
            vertical_gap = block.bbox[1] - tail.bbox[3]
            overlap = min(tail.bbox[2], block.bbox[2]) - max(tail.bbox[0], block.bbox[0])
            min_width = min(tail.width, block.width)
            mergeable = (
                not tail.heading
                and not block.heading
                and tail.col is not None
                and tail.col == block.col
                and -2.0 <= vertical_gap <= 1.6 * tail.line_height
                and overlap > 0.3 * min_width
                and not sentence_end(current["text"])
                and not BULLET_RE.match(block.text)
            )
        if mergeable:
            current["text"] = join_piece(current["text"], block.text)
            current["blocks"].append(block)
            current["bbox"] = (
                min(current["bbox"][0], block.bbox[0]),
                min(current["bbox"][1], block.bbox[1]),
                max(current["bbox"][2], block.bbox[2]),
                max(current["bbox"][3], block.bbox[3]),
            )
        else:
            current = {
                "text": block.text,
                "blocks": [block],
                "bbox": block.bbox,
                "heading": block.heading,
            }
            paragraphs.append(current)
    return paragraphs


def normalize_label(text):
    """章节标题归一化：只留字母数字与 CJK，便于 TOC 标题与正文标题匹配。"""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", (text or "").lower())


def derive_title(doc):
    """论文标题：优先 PDF 元数据，否则取第 1 页字号最大的文本块。"""
    metadata = doc.metadata or {}
    meta_title = str(metadata.get("title") or "").strip()
    if meta_title:
        return meta_title
    if doc.page_count == 0:
        return ""
    best = None
    for block in doc[0].get_text("dict").get("blocks") or []:
        if block.get("type") != 0:
            continue
        lines = block.get("lines") or []
        # 排除旋转文字（arXiv 侧边水印、图内文字）与 arXiv 编号行
        if any((line.get("dir") or (1, 0))[1] != 0 for line in lines):
            continue
        spans = [s for line in lines for s in (line.get("spans") or [])]
        if not spans:
            continue
        text = "".join(span.get("text") or "" for span in spans).strip()
        if not text or text.lower().startswith("arxiv:"):
            continue
        max_size = max(float(span.get("size") or 0) for span in spans)
        if best is None or max_size > best[0]:
            best = (max_size, text)
    return best[1] if best else ""


def build_sections(paras, toc, title):
    """用 TOC 给段落分组；无 TOC 时退化为标题启发式，最差「第 N 页」。"""
    sections = []

    def add_section(section_title, level, page, start_index):
        sections.append({
            "id": "s%d" % (len(sections) + 1),
            "title": section_title or ("第 %d 页" % page),
            "level": int(level) or 1,
            "page": int(page) or 1,
            "start": start_index,
            "paraIds": [],
        })

    if toc:
        previous_start = -1
        for entry in toc:
            level = int(entry[0] or 1)
            entry_title = str(entry[1] or "").strip()
            entry_page = max(1, int(entry[2] or 1))
            target = normalize_label(entry_title)
            start = None
            if target:
                for index in range(max(0, previous_start + 1), len(paras)):
                    para = paras[index]
                    if para["page"] < entry_page:
                        continue
                    if para["heading"] and target in normalize_label(para["text"]):
                        start = index
                        break
            if start is None:
                for index in range(max(0, previous_start + 1), len(paras)):
                    if paras[index]["page"] >= entry_page:
                        start = index
                        break
            if start is None:
                start = min(len(paras), previous_start + 1)
            add_section(entry_title, level, entry_page, start)
            previous_start = start
        if sections and sections[0]["start"] > 0:
            # 第一个 TOC 章节之前的卷首内容（标题/作者/摘要）单独成节
            sections.insert(0, {
                "id": "s0",
                "title": title or "卷首",
                "level": 1,
                "page": 1,
                "start": 0,
                "paraIds": [],
            })
            for index, section in enumerate(sections):
                section["id"] = "s%d" % (index + 1)
    else:
        headings = [index for index, para in enumerate(paras) if para["heading"]]
        if headings:
            for index in headings:
                add_section(paras[index]["text"], 1, paras[index]["page"], index)
        else:
            seen_pages = set()
            for index, para in enumerate(paras):
                if para["page"] in seen_pages:
                    continue
                seen_pages.add(para["page"])
                add_section("第 %d 页" % para["page"], 1, para["page"], index)
    if not sections and paras:
        add_section(title or "全文", 1, paras[0]["page"], 0)

    section_index = 0
    for index, para in enumerate(paras):
        while section_index + 1 < len(sections) and sections[section_index + 1]["start"] <= index:
            section_index += 1
        section = sections[section_index]
        para["sectionId"] = section["id"]
        section["paraIds"].append(para["id"])
    for section in sections:
        del section["start"]
    return sections


def collect_links(page):
    """归一化一页的 PDF 链接。

    关键实测：Attention 论文的引用/图表链接在 PyMuPDF 里是 kind=4（LINK_NAMED），
    但 page / to 已经被解析好，所以不能只认 LINK_GOTO：
      - 有合法 page（0-based）→ goto（转 1-based），带 page / to / named；
      - 有 uri → uri；
      - 其余（launch / file / 无 page 的 named / LINK_NONE）一律过滤。
    同一页按矩形面积从大到小排序（大块优先点）；text 取区域文字层（截断 120 字）。
    """
    links = []
    for raw in page.get_links() or []:
        source = raw.get("from")
        if not source:
            continue
        try:
            rect = [round(float(value), 2) for value in source]
        except (TypeError, ValueError):
            continue
        page_index = raw.get("page")
        has_page = isinstance(page_index, int) and page_index >= 0
        uri = raw.get("uri")
        if has_page:
            item = {"rect": rect, "kind": "goto", "page": int(page_index) + 1}
            target = raw.get("to")
            if target is not None:
                try:
                    item["to"] = [round(float(target.x), 2), round(float(target.y), 2)]
                except (AttributeError, TypeError, ValueError):
                    pass
            named = raw.get("nameddest") or raw.get("named")
            if isinstance(named, str) and named.strip():
                item["named"] = named.strip()
            links.append(item)
        elif isinstance(uri, str) and uri.strip():
            links.append({"rect": rect, "kind": "uri", "uri": uri.strip()})
        # 其它 kind（launch/named 无目标/LINK_NONE）不收录
    for item in links:
        try:
            words = page.get_text("words", clip=fitz.Rect(item["rect"]))
            item["text"] = " ".join(str(word[4]) for word in words).strip()[:120]
        except Exception:
            item["text"] = ""
    links.sort(
        key=lambda item: (item["rect"][2] - item["rect"][0]) * (item["rect"][3] - item["rect"][1]),
        reverse=True,
    )
    return links


def process_page(page, page_number):
    """抽取一页：返回 (page_meta, paragraphs, words, warnings)。

    paragraphs 是页内阅读顺序的段落草稿（尚无全局 paraId）；
    words 是 [[x0,y0,x1,y1,text,localIndex|null], ...]，localIndex 指向 paragraphs。
    """
    width = float(page.rect.width)
    height = float(page.rect.height)
    raw = page.get_text("dict")
    raw_blocks = [block for block in (raw.get("blocks") or []) if block.get("type") == 0]
    span_sizes = [
        float(span.get("size") or 0)
        for block in raw_blocks
        for line in (block.get("lines") or [])
        for span in (line.get("spans") or [])
    ]
    body_size = median(span_sizes, 10.0)

    blocks = []
    warnings = []
    for block in raw_blocks:
        info = read_block(block, body_size)
        if info is None:
            continue
        if PAGE_NUMBER_RE.fullmatch(info.text) and info.bbox[1] > height * 0.92:
            info.footer = True
        blocks.append(info)

    rotated_blocks = [block for block in blocks if block.rotated]
    if rotated_blocks:
        warnings.append("第 %d 页有 %d 个旋转文字块（图内文字）未纳入正文段落" % (page_number, len(rotated_blocks)))

    candidates = [block for block in blocks if not block.rotated and not block.footer]
    ordered, columns = order_blocks(candidates, width)
    paragraphs = merge_blocks(ordered)

    block_owner = {}
    for index, para in enumerate(paragraphs):
        for block in para["blocks"]:
            block_owner[id(block)] = index
    # 被排除的块（旋转图内文字 / 页脚）也参与几何回填：给最近的段落
    excluded_owner = {}
    for block in blocks:
        if id(block) in block_owner:
            continue
        excluded_owner[id(block)] = None

    raw_words = page.get_text("words")
    page_words = []
    for word in raw_words:
        x0, y0, x1, y1, text = word[0], word[1], word[2], word[3], word[4]
        center_x = (x0 + x1) / 2.0
        center_y = (y0 + y1) / 2.0
        owner = None
        # 1) 词中心落在哪个文本块里，就归属该块所在段落
        for block in blocks:
            bx0, by0, bx1, by1 = block.bbox
            if bx0 - 1 <= center_x <= bx1 + 1 and by0 - 1 <= center_y <= by1 + 1:
                candidate = block_owner.get(id(block))
                if candidate is not None:
                    owner = candidate
                    break
        # 2) 回退：按中心距离找最近的已入段块（覆盖旋转图内文字 / 页脚）
        if owner is None:
            best = None
            for block in blocks:
                candidate = block_owner.get(id(block))
                if candidate is None:
                    continue
                bx0, by0, bx1, by1 = block.bbox
                dx = max(bx0 - center_x, 0.0, center_x - bx1)
                dy = max(by0 - center_y, 0.0, center_y - by1)
                distance = dx * dx + dy * dy
                if best is None or distance < best[0]:
                    best = (distance, candidate)
            owner = best[1] if best else None
        page_words.append([
            round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2),
            text, owner,
        ])

    # 逐词按段落阅读顺序重排（同段内保持原始提取顺序）
    grouped = [[] for _ in paragraphs]
    leftovers = []
    for entry in page_words:
        if entry[5] is None:
            leftovers.append(entry)
        else:
            grouped[entry[5]].append(entry)
    words_out = []
    for entries in grouped:
        words_out.extend(entries)
    words_out.extend(leftovers)

    meta = {
        "n": page_number,
        "w": round(width, 2),
        "h": round(height, 2),
        "hasText": bool(raw_words),
    }
    if not raw_words:
        warnings.append("第 %d 页没有文字层（只能看图，无法选中）" % page_number)
    return meta, paragraphs, words_out, columns, warnings


def write_bytes_atomic(file_path, payload):
    """原子写二进制文件：同目录临时文件 + rename。"""
    directory = os.path.dirname(file_path)
    os.makedirs(directory, exist_ok=True)
    temp_path = "%s.%d.tmp" % (file_path, os.getpid())
    try:
        with open(temp_path, "wb") as handle:
            handle.write(payload)
        os.replace(temp_path, file_path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def write_json(file_path, payload):
    """原子写 JSON：同目录临时文件 + rename。"""
    write_bytes_atomic(file_path, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def links_only_cli(argv):
    """--links-only：只重建 links.json（老文档惰性回填用），几十毫秒级，不重跑页图/切句。"""
    if len(argv) != 4:
        fail("py-error", "用法：python3 extract.py --links-only <source.pdf> <outDir>", 2)
    source_path, out_dir = argv[2], argv[3]
    if not os.path.isfile(source_path):
        fail("bad-pdf", "文件不存在：%s" % source_path, 2)
    try:
        with open(source_path, "rb") as handle:
            head = handle.read(5)
    except OSError as exc:
        fail("bad-pdf", "无法读取文件：%s" % exc, 2)
    if head != b"%PDF-":
        fail("bad-pdf", "不是 PDF 文件（缺少 %PDF- 魔数）", 2)
    doc = None
    try:
        doc = fitz.open(source_path)
        if doc.needs_pass:
            fail("encrypted", "这是加密 PDF，无法抽取文字；请先解除密码再上传", 2)
        page_count = int(doc.page_count)
        if page_count <= 0:
            fail("bad-pdf", "PDF 没有任何页面", 2)
        pages = [{"n": page_index + 1, "links": collect_links(doc[page_index])} for page_index in range(page_count)]
        os.makedirs(out_dir, exist_ok=True)
        write_json(os.path.join(out_dir, "links.json"), {"version": 1, "pages": pages})
        print(json.dumps({
            "ok": True,
            "pageCount": page_count,
            "links": sum(len(page["links"]) for page in pages),
        }, ensure_ascii=False))
        sys.stdout.flush()
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        fail("py-error", "链接回填失败：%s: %s" % (type(exc).__name__, exc), 1)
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


MATH_FONT_TOKENS = (
    "CMR", "CMMI", "CMSY", "CMEX", "CMMIB", "CMBSY", "MSAM", "MSBM",
    "STIX", "Symbol", "Euclid", "LatinModernMath", "XITS", "Math",
)
MATH_CHARS = set("=+−-±∓×÷·⋅√∑∏∫∬∂∇∞≤≥≠≈≡≅∈∉⊂⊃⊆⊇∪∩∧∨¬→←↔⇒⇔∀∃^_{}()[]|/\\<>")


def _is_math_char(char):
    """数学/符号字符（含希腊字母、数学运算符、上下标数字）。"""
    if char in MATH_CHARS:
        return True
    code = ord(char)
    return (
        0x0370 <= code <= 0x03FF        # 希腊字母
        or 0x2200 <= code <= 0x22FF     # 数学运算符
        or 0x27C0 <= code <= 0x27EF     # 杂项数学符号
        or 0x2070 <= code <= 0x209F     # 上/下标数字
        or 0x1D400 <= code <= 0x1D7FF   # 数学字母数字
    )


def _weighted_median(values):
    """按字符数加权的“行内主导字号/基线”（避免一行只有 2 个 span 时中位数失效）。"""
    if not values:
        return 0.0
    values = sorted(values)
    return values[len(values) // 2]


def _line_reference(spans):
    """行的主导字号与主导基线（按 span 文本长度加权）。"""
    sizes = []
    baselines = []
    for span in spans:
        text = span.get("text") or ""
        weight = max(1, len(text))
        size = float(span.get("size") or 0)
        if size > 0:
            sizes.extend([size] * weight)
        origin = span.get("origin")
        baseline = float(origin[1]) if origin is not None else float((span.get("bbox") or (0, 0, 0, 0))[3])
        baselines.extend([baseline] * weight)
    return _weighted_median(sizes), _weighted_median(baselines)


def _render_line(spans):
    """把一行 span 从左到右拼成文本；上标 ^{…}、下标 _{…}（排版还原标记）。"""
    ref_size, ref_baseline = _line_reference(spans)
    chunks = []
    for span in sorted(spans, key=lambda item: ((item.get("bbox") or (0, 0, 0, 0))[0], (item.get("bbox") or (0, 0, 0, 0))[1])):
        text = span.get("text") or ""
        if not text.strip():
            continue
        bbox = span.get("bbox") or (0, 0, 0, 0)
        size = float(span.get("size") or 0)
        origin = span.get("origin")
        baseline = float(origin[1]) if origin is not None else float(bbox[3])
        flags = int(span.get("flags") or 0)
        superscript = False
        subscript = False
        if ref_size > 0 and size > 0 and size < ref_size * 0.85:
            if baseline < ref_baseline - 0.5:
                superscript = True
            elif baseline > ref_baseline + 0.5:
                subscript = True
        # 契约：flags & 1 是上标；但部分分子/分式 span 也误带该位，所以还要求字号明显偏小
        if not superscript and (flags & 1) and ref_size > 0 and size < ref_size * 0.9 and baseline < ref_baseline - 0.5:
            superscript = True
        text = text.strip()
        if superscript:
            text = "^{%s}" % text
        elif subscript:
            text = "_{%s}" % text
        chunks.append((text, float(bbox[0]), float(bbox[2]), size))
    out = ""
    previous_x1 = None
    previous_size = 10.0
    for text, x0, x1, size in chunks:
        if not text:
            continue
        if out and previous_x1 is not None:
            gap = x0 - previous_x1
            if gap > 0.12 * max(previous_size, size, 1.0) and not out.endswith(" ") and not text.startswith(" "):
                out += " "
        out += text
        previous_x1 = x1
        previous_size = size
    return out.strip()


def _line_kind(text, spans, line_bbox, page_width):
    """math：数学字体 / 数学符号占比 >30% / 明显居中排版；否则 text。"""
    fonts = " ".join(str(span.get("font") or "") for span in spans)
    if any(token in fonts for token in MATH_FONT_TOKENS):
        return "math"
    visible = [char for char in text if not char.isspace()]
    if visible:
        math_count = sum(1 for char in visible if _is_math_char(char))
        if math_count / float(len(visible)) > 0.3:
            return "math"
    x0, y0, x1, y1 = line_bbox
    width = x1 - x0
    if width > 0 and width < 0.65 * page_width and x0 > 0.12 * page_width and (page_width - x1) > 0.12 * page_width:
        return "math"
    return "text"


def _region_column_split(page):
    """页面级双栏判定（复用 detect_columns）；单栏返回 None。"""
    width = float(page.rect.width)
    raw = page.get_text("dict")
    raw_blocks = [block for block in (raw.get("blocks") or []) if block.get("type") == 0]
    sizes = [
        float(span.get("size") or 0)
        for block in raw_blocks
        for line in (block.get("lines") or [])
        for span in (line.get("spans") or [])
    ]
    body_size = median(sizes, 10.0)
    blocks = [read_block(block, body_size) for block in raw_blocks]
    blocks = [block for block in blocks if block is not None and not block.rotated]
    if not blocks:
        return None
    columns, split = detect_columns(blocks, width)
    return split if columns == "two" else None


def _select_region_lines(page, drag_rect):
    """选出与拖动矩形相交的文本行（垂直重叠 >40%，或细长选区按水平重叠兜底）。"""
    split = _region_column_split(page)
    page_width = float(page.rect.width)
    drag_height = max(0.01, drag_rect.height)
    selected = []
    for block in page.get_text("dict").get("blocks") or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            bbox = line.get("bbox")
            if not bbox:
                continue
            direction = line.get("dir") or (1, 0)
            if abs(direction[1]) > 1e-3:
                continue  # 旋转文字（图内文字）不参与公式重建
            line_rect = fitz.Rect(bbox)
            line_height = max(0.01, line_rect.height)
            line_width = max(0.01, line_rect.width)
            vertical_overlap = max(0.0, min(line_rect.y1, drag_rect.y1) - max(line_rect.y0, drag_rect.y0))
            horizontal_overlap = max(0.0, min(line_rect.x1, drag_rect.x1) - max(line_rect.x0, drag_rect.x0))
            primary = vertical_overlap > 0.4 * line_height and horizontal_overlap > 0
            thin = (
                horizontal_overlap > 0.3 * line_width
                and vertical_overlap > 0.2 * line_height
                and vertical_overlap >= 0.3 * drag_height
            )
            if not (primary or thin):
                continue
            spans = [span for span in (line.get("spans") or []) if (span.get("text") or "").strip()]
            if not spans:
                continue
            selected.append({"bbox": line_rect, "spans": spans})
    def sort_key(item):
        rect = item["bbox"]
        center_x = (rect.x0 + rect.x1) / 2.0
        column = 0 if split is None else (0 if center_x < split else 1)
        return (column, round(rect.y0, 1), rect.x0)
    selected.sort(key=sort_key)
    return selected


# OCR 区域渲染的目标宽度（px）与向外扩边（pt）：契约建议宽 1500-2000px、外扩 8-10pt
OCR_TARGET_WIDTH_PX = 1800.0
OCR_PAD_PT = 9.0


def _plugin_data_dir():
    """OCR 二进制缓存目录的父目录（宿主会通过 PR_PLUGIN_DATA 传入）。"""
    explicit = os.environ.get("PR_PLUGIN_DATA")
    if explicit:
        return explicit
    home = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
    return os.path.join(home, "plugin-data", "paper-reader")


def _ocr_source_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr.swift")


def _ensure_ocr_binary():
    """懒编译 ocr.swift 并缓存到 <plugin-data>/bin/ocr-<sha12>；失败返回 (None, 原因)。"""
    override = os.environ.get("PR_OCR_BIN")
    if override:
        if os.path.isfile(override) and os.access(override, os.X_OK):
            return override, None
        return None, "PR_OCR_BIN 指定的 OCR 二进制不可用：%s" % override

    source = _ocr_source_path()
    if not os.path.isfile(source):
        return None, "缺少 OCR 源码 ocr.swift：%s" % source
    try:
        with open(source, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()[:12]
    except OSError as exc:
        return None, "OCR 源码不可读：%s" % exc

    bin_dir = os.path.join(_plugin_data_dir(), "bin")
    bin_path = os.path.join(bin_dir, "ocr-%s" % digest)
    if os.path.isfile(bin_path) and os.access(bin_path, os.X_OK):
        return bin_path, None

    swiftc = os.environ.get("PR_SWIFTC") or "swiftc"
    try:
        timeout_ms = int(os.environ.get("PR_OCR_TIMEOUT_MS") or 20000)
    except (TypeError, ValueError):
        timeout_ms = 20000
    compile_timeout = min(60.0, max(5.0, timeout_ms / 1000.0))
    temp_path = bin_path + ".tmp-%d" % os.getpid()
    try:
        os.makedirs(bin_dir, exist_ok=True)
        proc = subprocess.run(
            [swiftc, "-O", source, "-o", temp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=compile_timeout,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-3:]
            return None, "swiftc 编译失败：%s" % (" / ".join(detail) or ("退出码 %d" % proc.returncode))
        os.chmod(temp_path, 0o755)
        os.replace(temp_path, bin_path)
        return bin_path, None
    except FileNotFoundError:
        return None, "找不到 swiftc（%s）；macOS 需安装 Command Line Tools（xcode-select --install）" % swiftc
    except subprocess.TimeoutExpired:
        return None, "swiftc 编译超时（%ds）" % int(compile_timeout)
    except Exception as exc:
        return None, "OCR 二进制准备失败：%s: %s" % (type(exc).__name__, exc)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _page_kind(page):
    """扫描页判定：整页位图覆盖 >70%，且文字层以不可见 OCR（texttrace type==3）为主。"""
    page_rect = page.rect
    area = float(page_rect.width) * float(page_rect.height)
    if area <= 0:
        return "vector"
    big_image = False
    try:
        infos = page.get_image_info() or []
    except Exception:
        infos = []
    for info in infos:
        bbox = info.get("bbox")
        if not bbox:
            continue
        width = max(0.0, float(bbox[2]) - float(bbox[0]))
        height = max(0.0, float(bbox[3]) - float(bbox[1]))
        if width * height / area > 0.7:
            big_image = True
            break
    if not big_image:
        return "vector"
    try:
        spans = page.get_texttrace() or []
    except Exception:
        spans = []
    total = len(spans)
    hidden = sum(1 for span in spans if span.get("type") == 3)
    if total > 0 and hidden > 0 and hidden / float(total) >= 0.5:
        return "scan"
    return "vector"


def _vision_ocr(page, clip, page_rect):
    """把区域渲染成 PNG 交给 macOS Vision OCR；返回 (ocr dict 或 None, 错误原因)。"""
    if str(os.environ.get("PR_OCR_ENABLED") or "1").strip().lower() in ("0", "false", "off", "no"):
        return None, "OCR 已禁用（ocrEnabled=false）"
    if "PR_OCR_TEXT" in os.environ:
        return {"text": os.environ.get("PR_OCR_TEXT") or "", "engine": "vision", "ms": 0, "mocked": True}, None

    binary, error = _ensure_ocr_binary()
    if binary is None:
        return None, error
    try:
        timeout_ms = int(os.environ.get("PR_OCR_TIMEOUT_MS") or 20000)
    except (TypeError, ValueError):
        timeout_ms = 20000

    padded = (clip + (-OCR_PAD_PT, -OCR_PAD_PT, OCR_PAD_PT, OCR_PAD_PT)) & page_rect
    if padded.is_empty or padded.width <= 0 or padded.height <= 0:
        padded = clip
    scale = max(1.0, min(16.0, OCR_TARGET_WIDTH_PX / max(1.0, float(padded.width))))
    temp_png = None
    started = time.time()
    try:
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=padded, alpha=False)
        handle, temp_png = tempfile.mkstemp(prefix="paper-reader-ocr-", suffix=".png")
        os.close(handle)
        pixmap.save(temp_png)
        proc = subprocess.run(
            [binary, temp_png],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(1.0, timeout_ms / 1000.0),
        )
        elapsed = int((time.time() - started) * 1000)
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
            return None, "视觉 OCR 失败（退出码 %d）%s" % (proc.returncode, ("：" + detail) if detail else "")
        text = (proc.stdout or b"").decode("utf-8", "replace").strip()
        return {"text": text, "engine": "vision", "ms": elapsed, "scale": round(scale, 2)}, None
    except subprocess.TimeoutExpired:
        return None, "视觉 OCR 超时（%dms）" % timeout_ms
    except Exception as exc:
        return None, "视觉 OCR 失败：%s: %s" % (type(exc).__name__, exc)
    finally:
        if temp_png and os.path.exists(temp_png):
            try:
                os.remove(temp_png)
            except OSError:
                pass


def region_cli(argv):
    """--region：框选区域 → 吸附矩形 + 行级重建（上下标标记），一次性 stdout JSON。"""
    if len(argv) != 5:
        fail("py-error", "用法：python3 extract.py --region <source.pdf> <page> <x0,y0,x1,y1>", 2)
    source_path = argv[2]
    try:
        page_number = int(argv[3])
    except (TypeError, ValueError):
        fail("bad-region", "页码必须是整数：%s" % argv[3], 2)
    parts = str(argv[4]).split(",")
    if len(parts) != 4:
        fail("bad-region", "rect 必须是 4 个数字：x0,y0,x1,y1", 2)
    try:
        coordinates = [float(part.strip()) for part in parts]
    except (TypeError, ValueError):
        fail("bad-region", "rect 坐标必须是数字：%s" % argv[4], 2)
    x0, y0, x1, y1 = coordinates
    if x1 <= x0 or y1 <= y0:
        fail("bad-region", "rect 必须满足 x1 > x0 且 y1 > y0", 2)
    if not os.path.isfile(source_path):
        fail("bad-pdf", "文件不存在：%s" % source_path, 2)

    doc = None
    try:
        doc = fitz.open(source_path)
        if doc.needs_pass:
            fail("encrypted", "这是加密 PDF，无法抽取文字；请先解除密码再上传", 2)
        total = int(doc.page_count)
        if page_number < 1 or page_number > total:
            fail("bad-region", "页码超出范围：第 %d 页（共 %d 页）" % (page_number, total), 2)
        page = doc[page_number - 1]
        page_rect = page.rect
        drag_rect = fitz.Rect(x0, y0, x1, y1)
        clipped_drag = drag_rect & page_rect
        if clipped_drag.is_empty or clipped_drag.width <= 0 or clipped_drag.height <= 0:
            fail("bad-region", "框选区域与页面没有交集", 2)

        selected = _select_region_lines(page, clipped_drag)
        warnings = []
        if selected:
            union = fitz.Rect(selected[0]["bbox"])
            for item in selected[1:]:
                union |= item["bbox"]
            snapped = union & page_rect
        else:
            snapped = clipped_drag
            warnings.append("框选区域没有文字层，只能依据上下文与版面位置推测")
        if snapped.is_empty or snapped.width <= 0 or snapped.height <= 0:
            snapped = clipped_drag

        page_width = float(page_rect.width)
        lines_out = []
        for item in selected:
            text = _render_line(item["spans"])
            if not text:
                continue
            lines_out.append({
                "text": text,
                "kind": _line_kind(text, item["spans"], item["bbox"], page_width),
                "bbox": [round(item["bbox"].x0, 2), round(item["bbox"].y0, 2),
                         round(item["bbox"].x1, 2), round(item["bbox"].y1, 2)],
            })
        region_text = "\n".join(line["text"] for line in lines_out)
        page_kind = _page_kind(page)
        ocr = None
        if page_kind == "scan":
            ocr_result, ocr_error = _vision_ocr(page, snapped, page_rect)
            if ocr_result is not None:
                ocr = ocr_result
            else:
                ocr = {"text": "", "engine": "vision", "ms": 0, "error": ocr_error or "视觉 OCR 不可用"}
                warnings.append("视觉 OCR 不可用：%s" % (ocr_error or "未知原因"))
        print(json.dumps({
            "ok": True,
            "page": page_number,
            "pageKind": page_kind,
            "rect": [round(snapped.x0, 2), round(snapped.y0, 2), round(snapped.x1, 2), round(snapped.y1, 2)],
            "lines": lines_out,
            "text": region_text,
            "ocr": ocr,
            "warnings": warnings,
        }, ensure_ascii=False))
        sys.stdout.flush()
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        fail("py-error", "区域抽取失败：%s: %s" % (type(exc).__name__, exc), 1)
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


def main(argv):
    if len(argv) >= 2 and argv[1] == "--region":
        return region_cli(argv)
    if len(argv) >= 2 and argv[1] == "--links-only":
        return links_only_cli(argv)
    if len(argv) != 3:
        fail("py-error", "用法：python3 extract.py <source.pdf> <outDir>", 2)
    source_path, out_dir = argv[1], argv[2]
    if not os.path.isfile(source_path):
        fail("bad-pdf", "文件不存在：%s" % source_path, 2)
    try:
        with open(source_path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        fail("bad-pdf", "无法读取文件：%s" % exc, 2)
    if raw[:5] != b"%PDF-":
        fail("bad-pdf", "不是 PDF 文件（缺少 %PDF- 魔数）", 2)
    digest = hashlib.sha256(raw).hexdigest()[:16]
    del raw

    doc = None
    try:
        doc = fitz.open(source_path)
        if doc.needs_pass:
            fail("encrypted", "这是加密 PDF，无法抽取文字；请先解除密码再上传", 2)
        page_count = int(doc.page_count)
        if page_count <= 0:
            fail("bad-pdf", "PDF 没有任何页面", 2)

        title = derive_title(doc)
        pages_dir = os.path.join(out_dir, "pages")
        os.makedirs(pages_dir, exist_ok=True)

        page_metas = []
        links_pages = []
        paras = []
        warnings = []
        word_total = 0

        # 逐页抽取并立刻写盘：structure.json 最后写，失败时不留“完整”假象
        for page_index in range(page_count):
            page_number = page_index + 1
            meta, page_paras, page_words, columns, page_warnings = process_page(doc[page_index], page_number)
            warnings.extend(page_warnings)
            page_metas.append(meta)
            links_pages.append({"n": page_number, "links": collect_links(doc[page_index])})
            base = len(paras)
            for offset, para in enumerate(page_paras):
                para["id"] = "p%d" % (base + offset + 1)
                para["page"] = page_number
                para["sectionId"] = None
                para["sent"] = split_sentences(para["text"])
                paras.append(para)

            output_words = []
            for entry in page_words:
                local = entry[5]
                para_id = "" if local is None else paras[base + local]["id"]
                output_words.append([
                    entry[0], entry[1], entry[2], entry[3], entry[4], para_id,
                ])
            word_total += len(output_words)

            write_json(
                os.path.join(pages_dir, "%d.json" % page_number),
                {"n": page_number, "columns": columns, "words": output_words},
            )
            pixmap = doc[page_index].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            png_bytes = pixmap.tobytes("png")
            # 页图只落 pages/<n>.png（不再写 doc 根目录镜像：media 路由直读这里）
            write_bytes_atomic(os.path.join(pages_dir, "%d.png" % page_number), png_bytes)

        toc = []
        try:
            toc = [entry for entry in doc.get_toc(simple=True) if entry and entry[1]]
        except Exception:
            toc = []
        if not toc:
            warnings.append("PDF 没有目录（TOC），章节按标题字号启发式或按页生成")
        sections = build_sections(paras, toc, title)

        structure = {
            "version": 1,
            "id": digest,
            "title": title,
            "pageCount": page_count,
            "pages": page_metas,
            "sections": sections,
            "paras": [
                {
                    "id": para["id"],
                    "page": para["page"],
                    "bbox": [
                        round(para["bbox"][0], 2),
                        round(para["bbox"][1], 2),
                        round(para["bbox"][2], 2),
                        round(para["bbox"][3], 2),
                    ],
                    "sectionId": para["sectionId"],
                    "text": para["text"],
                    "sent": para["sent"],
                }
                for para in paras
            ],
        }
        # links.json 在 structure.json 之前写；structure 仍是“抽取完成”的最后标记
        write_json(os.path.join(out_dir, "links.json"), {"version": 1, "pages": links_pages})
        write_json(os.path.join(out_dir, "structure.json"), structure)

        print(json.dumps({
            "ok": True,
            "pageCount": page_count,
            "paras": len(paras),
            "sections": len(sections),
            "words": word_total,
            "links": sum(len(page["links"]) for page in links_pages),
            "warnings": warnings,
        }, ensure_ascii=False))
        sys.stdout.flush()
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        fail(
            "py-error",
            "抽取失败：%s: %s\n%s" % (type(exc).__name__, exc, traceback.format_exc(limit=3)),
            1,
        )
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main(sys.argv))
