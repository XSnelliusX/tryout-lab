"""Offline, conservative validation of gateway-proposed vocabulary."""

from __future__ import annotations

import importlib.metadata
import re
import unicodedata


def _local_dictionary():
    try:
        import pypinyin
        from pypinyin.contrib.tone_convert import to_tone3
    except ImportError:
        return None
    try:
        version = importlib.metadata.version("pypinyin")
    except importlib.metadata.PackageNotFoundError:
        version = "unknown"
    return pypinyin, to_tone3, version


def _syllables(value, convert):
    # Spaces, apostrophes and hyphens are accepted syllable boundaries. A
    # missing boundary is intentionally not guessed for multi-syllable terms.
    value = unicodedata.normalize("NFC", value.lower().strip()).replace("u:", "ü").replace("v", "ü")
    parts = re.split(r"[\s'’\-]+", value)
    if not parts or any(not part for part in parts):
        return []
    try:
        result = [convert(part, neutral_tone_with_five=True).replace("ü", "v") for part in parts]
    except (ValueError, TypeError):
        return []
    if not all(re.fullmatch(r"[a-zv]+[1-5]", syllable) for syllable in result):
        return []
    return result


def validate_learning(data, segments) -> dict:
    """Check evidence and optional pypinyin readings without network access.

    `meaning` remains the model's contextual suggestion, not a dictionary
    definition. Even a dictionary-supported reading needs contextual review.
    """
    if not isinstance(data, dict) or not isinstance(data.get("items"), list) or not isinstance(segments, list):
        raise ValueError("Invalid learning data")
    sources = {}
    for segment in segments:
        if not isinstance(segment, dict) or type(segment.get("id")) is not int or not isinstance(segment.get("traditional_text"), str) or segment["id"] in sources:
            raise ValueError("Invalid learning source segments")
        sources[segment["id"]] = segment["traditional_text"]
    output = dict(data)
    output["items"] = []
    limitations = data.get("limitations", [])
    output["limitations"] = list(limitations) if isinstance(limitations, list) else []
    dictionary = _local_dictionary()
    rejected = 0
    for item in data["items"]:
        if not isinstance(item, dict):
            rejected += 1
            continue
        sid, quote, term, reading = (item.get(k) for k in ("segment_id", "quote", "term", "pinyin"))
        if (type(sid) is not int or sid not in sources or not isinstance(quote, str) or not quote.strip()
                or quote not in sources[sid] or not isinstance(term, str) or not term.strip() or len(term) > 100 or term not in quote
                or not isinstance(reading, str) or not reading.strip() or len(reading) > 300
                or not isinstance(item.get("meaning"), str) or not item["meaning"].strip()):
            rejected += 1
            continue
        clean = dict(item)
        # Never trust model-supplied validation or dictionary definitions.
        clean.pop("dictionary_meanings", None)
        clean["validation_status"] = "needs_review"
        clean["validation_flags"] = ["context_review_required", "taiwan_usage_review_required"]
        clean["dictionary_provenance"] = "pypinyin unavailable" if dictionary is None else "pypinyin"
        if dictionary is not None:
            pypinyin, convert, version = dictionary
            clean["dictionary_provenance"] = f"pypinyin {version} (local readings; not a meaning or Taiwan-variant dictionary)"
            try:
                # Check each character independently: phrase-level lookup may
                # hide a heteronym selected by the library's own context guess.
                candidates = [pypinyin.pinyin(char, style=pypinyin.Style.TONE3, heteronym=True,
                                              neutral_tone_with_five=True, errors=lambda chars: list(chars))[0]
                              for char in term]
                normalized = [[str(x).lower().replace("ü", "v").replace("u:", "v") for x in options] for options in candidates]
                proposed = _syllables(reading, convert)
                supported = (len(normalized) == len(term) == len(proposed)
                             and all(re.fullmatch(r"[a-zv]+[1-5]", x) for options in normalized for x in options)
                             and all(value in options for value, options in zip(proposed, normalized)))
                if any(len(set(options)) > 1 for options in normalized):
                    clean["validation_flags"].append("heteronym_review_required")
                if supported and all(len(set(options)) == 1 for options in normalized):
                    clean["validation_status"] = "dictionary_supported"
                # Ambiguous heteronyms or unsupported Taiwan variants stay review-needed.
            except (ValueError, TypeError, AttributeError):
                pass
        output["items"].append(clean)
    if rejected:
        output["limitations"].append(f"Rejected {rejected} learning item(s) with invalid source evidence.")
    if dictionary is None:
        output["limitations"].append("Local pypinyin is unavailable; all readings need review.")
    else:
        output["limitations"].append("Pypinyin only checks possible readings, not contextual meaning or Taiwan usage; heteronyms require review.")
    return output


def select_learning(data, vocabulary=None, limit=30):
    """Keep a bounded study list without inventing frequency or proficiency scores."""
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Invalid learning result")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("Learning item limit must be between 1 and 100")
    terms = {item["term"]: item for item in vocabulary or []}
    selected, seen, known_count = [], set(), 0
    for item in data["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("term"), str):
            continue
        term = item["term"]
        if terms.get(term, {}).get("known"):
            known_count += 1
            continue
        key = (term, item.get("pinyin", ""))
        if key in seen:
            continue
        seen.add(key)
        selected.append(dict(item, known=False))
    # Retain the gateway's source-grounded order; we have no measured difficulty
    # model and must not pretend a heuristic estimates the learner's proficiency.
    output = dict(data)
    output["items"] = selected[:limit]
    output["selection"] = {"proposed": len(data["items"]), "unique_unknown": len(selected),
                           "known_excluded": known_count, "limit": limit,
                           "method": "unique term/reading; known terms excluded; source-proposal order"}
    output["limitations"] = list(data.get("limitations", [])) + [
        "Study selection is not a validated proficiency ranking; review usefulness and difficulty yourself."]
    return output
