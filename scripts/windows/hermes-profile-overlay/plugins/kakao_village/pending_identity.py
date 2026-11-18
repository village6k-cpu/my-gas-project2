"""Evidence-bound completion of an existing pending inquiry's customer form."""
import re
import unicodedata


def normalize_pending_identity(value, source_text, room_memo=""):
    if value is None:
        return None
    fields = {"expected_name", "expected_phone", "name", "phone"}
    if (not isinstance(value, dict) or set(value) - fields - {"discount_type"}
            or any(not isinstance(value.get(key), str) for key in fields)):
        raise ValueError("customer_identity_update requires exact old and final identity fields")
    result = {key: unicodedata.normalize("NFKC", value[key]).strip() for key in fields}
    phone = re.sub(r"\D", "", result["phone"])
    previous_phone = re.sub(r"\D", "", result["expected_phone"])
    source = unicodedata.normalize("NFKC", str(source_text or ""))
    contact_source = source + "\n" + unicodedata.normalize("NFKC", room_memo)
    if (not result["name"] or len(result["name"]) > 120 or not result["expected_name"]
            or re.fullmatch(r"[\d\s()+.\-]+", result["phone"]) is None
            or not 8 <= len(phone) <= 15 or (previous_phone and previous_phone != phone and phone not in re.sub(r"[\s()+.\-]", "", source))
            or (result["name"] != result["expected_name"] and result["name"] not in source)
            or phone not in re.sub(r"[\s()+.\-]", "", contact_source)):
        raise ValueError("customer_identity_update contradicts existing contact or selected customer evidence")
    if "discount_type" in value:
        if value["discount_type"] not in {"일반", "학생", "개인사업자/프리랜서", "단골", "제휴"}:
            raise ValueError("customer_identity_update.discount_type is invalid")
        result["discount_type"] = value["discount_type"]
    return result
