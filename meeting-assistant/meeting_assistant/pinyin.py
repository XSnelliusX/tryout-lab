"""On-demand Mandarin pinyin lookup with explicit handling of ambiguity and unavailability."""

import re

try:
    from pypinyin import Style, pinyin as _pypinyin
except Exception:
    Style = None
    _pypinyin = None

try:
    from opencc import OpenCC as _OpenCC
except Exception:
    _OpenCC = None

_CJK_RE = re.compile(r"([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f]+)")
_HAS_LATIN = re.compile(r"[A-Za-z\u00c0-\u024f]")
_MAX_TEXT_CHARS = 5000
_T2S = None


def _t2s():
    global _T2S
    if _T2S is None and _OpenCC is not None:
        try:
            _T2S = _OpenCC("t2s")
        except Exception:
            _T2S = False
    return _T2S if _T2S not in (None, False) else None


def pinyin_status() -> dict:
    """Report whether local pinyin lookup is available in this runtime."""
    available = _pypinyin is not None and Style is not None
    return {
        "available": available,
        "reason": None if available else "Pronunciation lookup is unavailable in this environment.",
    }


def has_chinese(text: str) -> bool:
    """True when text contains at least one CJK ideograph."""
    return isinstance(text, str) and bool(_CJK_RE.search(text))


def _dedupe_readings(items) -> list[str]:
    seen = set()
    out = []
    for item in items or ():
        if not isinstance(item, str):
            continue
        cleaned = item.strip()
        if cleaned and _HAS_LATIN.search(cleaned) and cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)
    return out


def analyze_pinyin(text: str, *, _engine=None) -> dict:
    """Return per-span pinyin annotations without presenting ambiguous readings as certain.

    When ``_engine`` is explicitly passed as ``False`` (or ``pypinyin`` cannot be imported),
    returns ``available=False`` rather than synthesizing readings.
    """
    if not isinstance(text, str):
        raise ValueError("Text for pronunciation lookup must be a string.")
    if len(text) > _MAX_TEXT_CHARS:
        raise ValueError(f"Text exceeds { _MAX_TEXT_CHARS } character limit for pronunciation lookup.")
    contains_cjk = has_chinese(text)
    engine = _pypinyin if _engine is None else _engine
    if not engine or Style is None:
        return {
            "available": False,
            "has_chinese": contains_cjk,
            "reason": "Pronunciation lookup is unavailable in this environment.",
            "tokens": [],
            "has_ambiguous": False,
            "unavailable_count": 0,
        }
    if not contains_cjk:
        return {
            "available": True,
            "has_chinese": False,
            "reason": None,
            "tokens": [{"text": text, "is_chinese": False}] if text else [],
            "has_ambiguous": False,
            "unavailable_count": 0,
        }

    tokens = []
    has_ambiguous = False
    unavailable_count = 0
    converter = _t2s()

    for part in _CJK_RE.split(text):
        if not part:
            continue
        if not _CJK_RE.fullmatch(part):
            tokens.append({"text": part, "is_chinese": False})
            continue
        hetero = engine(
            part,
            style=Style.TONE,
            heteronym=True,
            strict=False,
            errors=lambda s: [[] for _ in s],
        )
        # Convert Traditional -> Simplified only as input to phrase-level candidate
        # guessing when character alignment matches 1:1; preserve heteronyms from the
        # original characters so Traditional distinctions (e.g. 髮 vs 發) stay intact.
        phrase_input = part
        if converter is not None:
            converted = converter.convert(part)
            if isinstance(converted, str) and len(converted) == len(part):
                phrase_input = converted
        phrase = engine(
            phrase_input,
            style=Style.TONE,
            heteronym=False,
            strict=False,
            errors=lambda s: [[] for _ in s],
        )
        for idx, ch in enumerate(part):
            alts = _dedupe_readings(hetero[idx] if idx < len(hetero) else [])
            if not alts:
                unavailable_count += 1
                tokens.append({
                    "text": ch,
                    "is_chinese": True,
                    "available": False,
                    "ambiguous": False,
                    "reading": None,
                    "alternatives": [],
                })
                continue
            if len(alts) == 1:
                tokens.append({
                    "text": ch,
                    "is_chinese": True,
                    "available": True,
                    "ambiguous": False,
                    "reading": alts[0],
                    "alternatives": alts,
                })
                continue
            has_ambiguous = True
            phrase_alts = _dedupe_readings(phrase[idx] if idx < len(phrase) else [])
            candidate = phrase_alts[0] if phrase_alts and phrase_alts[0] in alts else alts[0]
            ordered = [candidate] + [item for item in alts if item != candidate]
            tokens.append({
                "text": ch,
                "is_chinese": True,
                "available": True,
                "ambiguous": True,
                "reading": candidate,
                "alternatives": ordered,
            })

    return {
        "available": True,
        "has_chinese": True,
        "reason": None,
        "tokens": tokens,
        "has_ambiguous": has_ambiguous,
        "unavailable_count": unavailable_count,
    }
