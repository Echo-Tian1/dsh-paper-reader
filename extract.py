#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文献阅读坞 · PDF 抽取器（宿主半）

用法：
    python3 extract.py <source.pdf> <outDir>                  # 全量抽取
    python3 extract.py --region <pdf> <page> <x0,y0,x1,y1>    # 框选区域文字层（一次性，stdout 一行 JSON）

产物：
    <outDir>/structure.json      章节 / 段落 / 句子区间 / 页元数据（最后写，失败时不留“完整”假象）
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
import sys
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


def region_cli(argv):
    """--region 子命令：一次性抽取某页矩形区域的文字层（无守护进程，单次 <1s）。"""
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
        clip = fitz.Rect(x0, y0, x1, y1) & page.rect
        if clip.is_empty or clip.width <= 0 or clip.height <= 0:
            fail("bad-region", "框选区域与页面没有交集", 2)
        text = page.get_text("text", clip=clip)
        print(json.dumps({
            "ok": True,
            "page": page_number,
            "rect": [round(clip.x0, 2), round(clip.y0, 2), round(clip.x1, 2), round(clip.y1, 2)],
            "hasText": bool(text.strip()),
            "text": text,
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
        paras = []
        warnings = []
        word_total = 0

        # 逐页抽取并立刻写盘：structure.json 最后写，失败时不留“完整”假象
        for page_index in range(page_count):
            page_number = page_index + 1
            meta, page_paras, page_words, columns, page_warnings = process_page(doc[page_index], page_number)
            warnings.extend(page_warnings)
            page_metas.append(meta)
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
        write_json(os.path.join(out_dir, "structure.json"), structure)

        print(json.dumps({
            "ok": True,
            "pageCount": page_count,
            "paras": len(paras),
            "sections": len(sections),
            "words": word_total,
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
