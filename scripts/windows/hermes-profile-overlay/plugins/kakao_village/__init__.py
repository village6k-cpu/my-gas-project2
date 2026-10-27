"""Kakao Village platform plugin registration boundary."""

from __future__ import annotations

from typing import Any

from .confirmation_tool import handle_confirmation_request
from .confirmed_reservation_commit_tool import handle_confirmed_reservation_commit
from .document_tool import handle_document_send
from .registered_change_tool import handle_registered_reservation_change
from .read_tool import handle_read
from .confirmation_schema import enrich_confirmation_schema, enrich_registration_schema

READ_SCHEMA = {
    "name": "village_read",
    "description": (
        "Read authoritative Village data without creating, changing or sending anything. "
        "knowledge + question reads reference-only shop knowledge/RAG for aliases, default models and procedures. "
        "Include relevant conversation context in the question. Reference knowledge cannot prove current inventory, prices, identity or booking authorization. "
        "Use catalog + query for broad exact-name/unit-price discovery; catalog + query='*' returns all exact catalog names when spelling or brands differ. A search miss does not prove missing ownership. customer + name + optional phone "
        "for customerDB discount; reservations + query(customer name) to find existing RQs/trades; "
        "request + query(RQ ID) or trade + query(trade ID) for current rows. "
        "Use quote + quote:{source:catalog,customer_name,phone,discount_type,start_date,start_time,end_date,end_time,"
        "items:[{name,quantity}]} for an unregistered price preview. Sets are one billable item. "
        "Or quote:{source:trade|request,id} for an existing booking. Dates YYYY-MM-DD, times HH:mm. "
        "discount_type: 학생, 개인사업자/프리랜서, 단골, 제휴, 일반. CustomerDB discount wins. "
        "A complete quote returns authoritative unit prices and VAT-included total, without confirming availability. "
        "Copy that exact quote request to FINAL_JSON.price_quote when answering its price. "
        "Read before deferring a price/booking question: lack of an RQ is not a reason to skip calculation."
    ),
    "parameters": {
        "type":"object","required":["request"],"additionalProperties":False,
        "properties":{"request":{
            "type":"object","required":["kind"],"additionalProperties":False,
            "properties":{
                "kind":{"type":"string","enum":["catalog","customer","reservations","request","trade","quote","knowledge"]},
                "query":{"type":"string","minLength":1,"maxLength":120},
                "question":{"type":"string","minLength":1,"maxLength":4000},
                "name":{"type":"string","minLength":1,"maxLength":120},
                "phone":{"type":"string","maxLength":30},
                "quote":{"type":"object","required":["source"],"additionalProperties":False,"properties":{
                    "source":{"type":"string","enum":["catalog","trade","request"]},
                    "id":{"type":"string"},
                    "customer_name":{"type":"string"},
                    "phone":{"type":"string"},
                    "discount_type":{"type":"string","enum":["학생","개인사업자/프리랜서","단골","제휴","일반"]},
                    "start_date":{"type":"string"},"start_time":{"type":"string"},
                    "end_date":{"type":"string"},"end_time":{"type":"string"},
                    "items":{"type":"array","items":{"type":"object","required":["name","quantity"],
                        "additionalProperties":False,"properties":{"name":{"type":"string"},"quantity":{"type":"integer","minimum":1}}}}
                }}
            }
        }}
    }
}


CONFIRMATION_REQUEST_SCHEMA = {
    "name": "village_confirmation_request",
    "description": (
        "This is the execution path for writing a native Gateway inquiry "
        "decision against the Village "
        "confirmation-request sheet. "
        "For every new customer equipment inquiry without an authoritative "
        "unchanged duplicate, call this tool before FINAL_JSON without waiting "
        "for a staff reply. If the schedule is incomplete, keep unknown schedule "
        "fields blank, set plan_complete=false, and send the full decision. "
        "For an unchanged existing RQ, use village_read instead: a read must "
        "not consume the mutation lease. For additions_only or replace_full_plan, "
        "call exactly once with should_write_to_sheet=true; the bridge verifies "
        "the exact RQ inside that operation, so never pre-verify a write. A "
        "no_action receipt means no row was written and is not success. "
        "Returned schedule results require owner review. A separate complete "
        "price quote from village_read may answer a price question with "
        "price_quote and fresh send-time verification, but grants no schedule authority."
    ),
    "parameters": {
        "type": "object",
        "required": ["decision"],
        "properties": {
            "decision": {
                "type": "object",
                "required": ["should_write_to_sheet", "safety_checks", "sheet_row_candidate"],
                "properties": {
                    "should_write_to_sheet": {"type": "boolean"},
                    "reservation_inquiry": {
                        "type": "object",
                        "properties": {
                            "is_reservation_inquiry": {"type": "boolean"},
                        },
                        "additionalProperties": True,
                    },
                    "existing_confirm_request_ids": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "pattern": r"^RQ-\d{6}-\d{3}$",
                        },
                    },
                    "safety_checks": {
                        "type": "object",
                        "required": [
                            "kakao_conversation_opened",
                            "did_not_classify_from_preview_only",
                            "latest_customer_message_after_last_staff_reply",
                        ],
                        "properties": {
                            "kakao_conversation_opened": {"type": "boolean"},
                            "did_not_classify_from_preview_only": {"type": "boolean"},
                            "latest_customer_message_after_last_staff_reply": {"type": "boolean"},
                        },
                        "additionalProperties": True,
                    },
                    "sheet_row_candidate": {
                        "type": "object",
                        "properties": {
                            "discount_type": {
                                "type": "string",
                                "enum": ["학생", "개인사업자/프리랜서", "단골", "제휴", "일반"],
                            },
                        },
                        "additionalProperties": True,
                    },
                },
                "additionalProperties": True,
            },
        },
        "additionalProperties": False,
    },
}

DOCUMENT_SEND_SCHEMA = {
    "name": "village_document_send",
    "description": (
        "Send one official registered-trade quote through the Village document API. "
        "Hermes selects the exact trade_id and tax_mode from the opened Kakao conversation. "
        "Use supply_only only when the customer explicitly requests a VAT-exclusive quote; "
        "that PDF omits the supply/VAT rows and shows a VAT-exclusive total. Call this tool "
        "before claiming the quote was sent. Only a successful correlated receipt proves delivery; "
        "on any tool error do not promise delivery and require owner review."
    ),
    "parameters": {
        "type": "object",
        "required": ["document_type", "trade_id", "tax_mode"],
        "properties": {
            "document_type": {"type": "string", "enum": ["quote"]},
            "trade_id": {"type": "string", "pattern": r"^\d{6}-\d{3}$"},
            "tax_mode": {"type": "string", "enum": ["vat_included", "supply_only"]},
        },
        "additionalProperties": False,
    },
}

REGISTERED_CHANGE_SCHEMA = {
    "name": "village_registered_reservation_change",
    "description": (
        "Confirmed external procurement uses kind external_supply_allocation on one existing row: "
        "expected_before=[{schedule_id,name,quantity:TOTAL DEMAND}], desired_after=[], date_change=null, no request_id, "
        "external_supply={supplier,quantity:CONFIRMED EXTERNAL COUNT,expected_note:EXACT CURRENT NOTE}. "
        "Record confirmed supplier allocation now; actual pickup and return remain separate physical work. "
        "Pending sourcing is not confirmed. Never add demand or mark pickup through this kind. "
        "Apply one staff-confirmed correction to an already registered Village trade. "
        "Use only after opening the Kakao conversation and identifying the exact registered trade, "
        "the customer's requested change, and explicit staff confirmation. This tool only transports "
        "the typed decision; it does not infer intent. expected_before and desired_after are affected-row deltas, "
        "except reservation_cancel, which requires ALL current schedule rows including components in expected_before, "
        "desired_after=[], date_change=null and no request_id. Resolve the exact agreed cancellation using the full "
        "conversation and live booking; interpret intent semantically, not with keywords. Cancelling one item uses "
        "equipment_remove. Refund or fees and customer sending are separate work. Other changes use deltas. Add uses only desired_after; remove uses only expected_before; replace uses "
        "both; quantity change uses the same exact identities with different quantities; date_time_change uses empty "
        "equipment deltas and a changed period. When the same staff approval covers both equipment and dates, use "
        "equipment_and_date_change with the exact affected rows and changed period in one call. Do not apply only "
        "the date first and leave the equipment for a second mutation. The verified registered trade and staff approval authorize the change. "
        "Include request_id only for a live pending inquiry for this exact equipment change; the operation finalizes "
        "that RQ after schedule readback. Its entire equipment plan must equal this exact delta; a related customer/date is insufficient. "
        "Reconcile all outstanding approved additions across the conversation and current schedule, not only the last bubble. "
        "When no exact RQ exists or it is partially applied, omit request_id and execute only the missing delta against the trade. "
        "Never recreate a completed intake RQ. Date-only changes must not carry an RQ. Call once before claiming "
        "the change was applied. Only error.details.code=REGISTERED_CORRECTION_PREFLIGHT_REJECTED with "
        "noMutationPerformed=true permits fresh read-only reconciliation and a corrected input in this turn (up to two corrections). "
        "All other failed, partial or uncertain outcomes must not be replayed."
    ),
    "parameters": {
        "type": "object",
        "required": ["mutation"],
        "properties": {
            "mutation": {
                "type": "object",
                "required": [
                    "confirmed", "kind", "target_scope", "trade_id", "source_evidence",
                    "expected_period", "expected_before", "desired_after", "date_change",
                ],
                "properties": {
                    "confirmed": {"type": "boolean", "const": True},
                    "kind": {"type": "string", "enum": [
                        "external_supply_allocation", "equipment_add", "equipment_remove", "equipment_replace",
                        "equipment_quantity_change", "date_time_change", "equipment_and_date_change", "reservation_cancel",
                    ]},
                    "target_scope": {"type": "string", "const": "registered_trade"},
                    "trade_id": {"type": "string", "pattern": r"^\d{6}-\d{3}$"},
                    "request_id": {"type": "string", "pattern": r"^RQ-\d{6}-\d{3}$"},
                    "source_evidence": {
                        "type": "object", "required": ["customer_request", "staff_confirmation", "conversation_revision"],
                        "properties": {
                            "customer_request": {"type": "string", "minLength": 1},
                            "staff_confirmation": {"type": "string", "minLength": 1},
                            "conversation_revision": {"type": "integer", "minimum": 1},
                        }, "additionalProperties": False,
                    },
                    "expected_period": {
                        "type": "object", "required": ["start_date", "start_time", "end_date", "end_time"],
                        "properties": {
                            "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "start_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):[0-5]\d$"},
                            "end_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "end_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):[0-5]\d$"},
                        }, "additionalProperties": False,
                    },
                    "expected_before": {"type": "array", "items": {
                        "type": "object", "required": ["schedule_id", "name", "quantity"],
                        "properties": {
                            "schedule_id": {"type": "string", "pattern": r"^\d{6}-\d{3}-\d{2,}$"},
                            "name": {"type": "string", "minLength": 1},
                            "quantity": {"type": "integer", "minimum": 1},
                        }, "additionalProperties": False,
                    }},
                    "desired_after": {"type": "array", "items": {
                        "type": "object", "required": ["name", "quantity"],
                        "properties": {"name": {"type": "string", "minLength": 1}, "quantity": {"type": "integer", "minimum": 1}},
                        "additionalProperties": False,
                    }},
                    "external_supply": {"type":"object", "required":["supplier","quantity","expected_note"], "properties":{
                        "supplier":{"type":"string","minLength":1,"pattern":r"^[^|\r\n]+$"},
                        "quantity":{"type":"integer","minimum":1}, "expected_note":{"type":"string"}
                    }, "additionalProperties":False},
                    "date_change": {"type": ["object", "null"], "properties": {
                        "new_start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                        "new_start_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):[0-5]\d$"},
                        "new_end_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                        "new_end_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):[0-5]\d$"},
                    }, "required": ["new_start_date", "new_start_time", "new_end_date", "new_end_time"], "additionalProperties": False},
                },
                "oneOf": [
                    {"properties":{"kind":{"const":"external_supply_allocation"},"expected_before":{"minItems":1,"maxItems":1},"desired_after":{"maxItems":0},"date_change":{"type":"null"}},"required":["external_supply"],"not":{"required":["request_id"]}},
                    {"properties": {
                        "kind": {"const": "reservation_cancel"},
                        "expected_before": {"minItems": 1},
                        "desired_after": {"maxItems": 0},
                        "date_change": {"type": "null"},
                    }, "not": {"required": ["request_id"]}},
                    {"properties": {
                        "kind": {"const": "equipment_and_date_change"},
                        "date_change": {"type": "object"},
                    }, "anyOf": [
                        {"properties": {"expected_before": {"minItems": 1}}},
                        {"properties": {"desired_after": {"minItems": 1}}},
                    ]},
                    {"properties": {
                        "kind": {"const": "equipment_add"},
                        "expected_before": {"maxItems": 0},
                        "desired_after": {"minItems": 1},
                        "date_change": {"type": "null"},
                    }},
                    {"properties": {
                        "kind": {"const": "equipment_remove"},
                        "expected_before": {"minItems": 1},
                        "desired_after": {"maxItems": 0},
                        "date_change": {"type": "null"},
                    }},
                    {"properties": {
                        "kind": {"const": "equipment_replace"},
                        "expected_before": {"minItems": 1},
                        "desired_after": {"minItems": 1},
                        "date_change": {"type": "null"},
                    }},
                    {"properties": {
                        "kind": {"const": "equipment_quantity_change"},
                        "expected_before": {"minItems": 1},
                        "desired_after": {"minItems": 1},
                        "date_change": {"type": "null"},
                    }},
                    {"properties": {
                        "kind": {"const": "date_time_change"},
                        "expected_before": {"maxItems": 0},
                        "desired_after": {"maxItems": 0},
                        "date_change": {"type": "object"},
                    }, "not": {"required": ["request_id"]}},
                ],
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    },
}

CONFIRMED_RESERVATION_COMMIT_SCHEMA = {
    "name": "village_confirmed_reservation_commit",
    "description": (
        "Register one exact pending Village confirmation request only after native Hermes has read the "
        "full same-room conversation and semantically concluded that a Village staff reply clearly and "
        "unconditionally authorizes that exact customer request. Staff wording is open-ended: do not use "
        "a fixed phrase or keyword list. A short reply is authorization only when its conversational target "
        "is unambiguous. Never call for a conditional, tentative, customer-authored, stale, or conflicting "
        "reply. Provide the exact current RQ, full before/after equipment plans, both periods, and verbatim "
        "bounded evidence from the current revision. This transport tool does not infer intent. Call exactly "
        "once; only its correlated authoritative receipt proves registration, and success requires no "
        "duplicate Kakao reply. If the inquiry and later staff authorization were coalesced before an RQ existed, "
        "use request_id=null plus pending_request_candidate. Always provide exact expected_set_components and "
        "set_component_selections as top-level typed fields, "
        "so this one atomic call creates or reuses the RQ, applies and rechecks those selections, then registers it; "
        "never invent an RQ ID or split it into two tools. Use village_registered_reservation_change "
        "instead for an already registered trade. Later customer questions do not automatically cancel staff approval. "
        "Judge whether the selected staff approval still authorizes the exact current plan using the entire conversation, "
        "including later cancellation, changed equipment, dates, conditions or withdrawn approval. Approval need not be the "
        "latest staff message or the conversation tail. confirmed=true expresses that semantic judgment; "
        "no separate post_confirmation_review is required. DOM role unknown is missing extractor metadata: "
        "infer the actual speaker from conversation and layout, then cite the existing IDs without changing their text. "
        "Do not contradict known opposing sender roles or treat customer-authored approval as staff authorization. "
        "Copy evidence verbatim using real newline characters, not literal backslash-n."
    ),
    "parameters": {
        "type": "object",
        "required": ["registration"],
        "properties": {
            "registration": {
                "type": "object",
                "required": [
                    "confirmed", "target_scope", "request_id", "source_evidence",
                    "expected_before", "expected_set_components", "set_component_selections",
                    "expected_period", "desired_after", "desired_period",
                ],
                "properties": {
                    "confirmed": {"type": "boolean", "const": True},
                    "target_scope": {"type": "string", "const": "pending_request"},
                    "request_id": {"type": ["string", "null"], "pattern": r"^RQ-\d{6}-\d{3}$"},
                    "pending_request_candidate": {
                        "type": "object",
                        "required": ["customer_name", "phone", "discount_type", "memo", "extra_request"],
                        "properties": {
                            "customer_name": {"type": "string", "minLength": 1, "maxLength": 120},
                            "phone": {"type": "string", "minLength": 1, "maxLength": 80},
                            "discount_type": {
                                "type": "string",
                                "enum": ["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"],
                            },
                            "memo": {"type": "string", "maxLength": 500},
                            "extra_request": {"type": "string", "maxLength": 1000},
                        },
                        "additionalProperties": False,
                    },
                    "source_evidence": {
                        "type": "object",
                        "required": [
                            "customer_request", "staff_confirmation", "conversation_revision",
                            "conversation_evidence_hash", "customer_message_ids", "staff_message_ids",
                        ],
                        "properties": {
                            "customer_request": {"type": "string", "minLength": 1, "maxLength": 2000},
                            "staff_confirmation": {"type": "string", "minLength": 1, "maxLength": 2000},
                            "conversation_revision": {"type": "integer", "minimum": 1},
                            "conversation_evidence_hash": {
                                "type": "string", "pattern": r"^[a-f0-9]{64}$",
                            },
                            "customer_message_ids": {
                                "type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": True,
                                "items": {"type": "string", "pattern": r"^[A-Za-z0-9._:-]{1,160}$"},
                            },
                            "staff_message_ids": {
                                "type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": True,
                                "items": {"type": "string", "pattern": r"^[A-Za-z0-9._:-]{1,160}$"},
                            },
                            "post_confirmation_review": {
                                "type": "object",
                                "required": ["message_ids", "reservation_unchanged", "reason"],
                                "properties": {
                                    "message_ids": {"type": "array", "minItems": 1, "maxItems": 20,
                                                    "uniqueItems": True,
                                                    "items": {"type": "string", "pattern": r"^[A-Za-z0-9._:-]{1,160}$"}},
                                    "reservation_unchanged": {"type": "boolean", "enum": [True]},
                                    "reason": {"type": "string", "minLength": 1, "maxLength": 1000},
                                },
                                "additionalProperties": False,
                            },
                            "room_memo": {
                                "type": "string", "minLength": 1, "maxLength": 1000,
                                "description": "Exact captured same-room memo for contact completion; server binds it to the immutable snapshot separately from customer/staff messages.",
                            },
                        },
                        "additionalProperties": False,
                    },
                    "expected_before": {
                        "type": "array", "minItems": 1, "maxItems": 40,
                        "items": {
                            "type": "object", "required": ["name", "quantity"],
                            "properties": {
                                "name": {"type": "string", "minLength": 1, "maxLength": 120},
                                "quantity": {"type": "integer", "minimum": 1, "maximum": 999},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "expected_set_components": {
                        "type": "array", "maxItems": 120,
                        "items": {
                            "type": "object", "required": ["set_item", "component_item", "quantity"],
                            "properties": {
                                "set_item": {"type": "string", "minLength": 1, "maxLength": 120},
                                "component_item": {"type": "string", "minLength": 1, "maxLength": 120},
                                "quantity": {"type": "integer", "minimum": 1, "maximum": 999},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "set_component_selections": {
                        "type": "array", "maxItems": 40,
                        "items": {
                            "type": "object", "required": ["set_item", "component_item", "selected_item"],
                            "properties": {
                                "set_item": {"type": "string", "minLength": 1, "maxLength": 120},
                                "component_item": {"type": "string", "minLength": 1, "maxLength": 120},
                                "selected_item": {"type": "string", "minLength": 1, "maxLength": 120},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "expected_period": {
                        "type": "object", "required": ["start_date", "start_time", "end_date", "end_time"],
                        "properties": {
                            "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "start_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):00$"},
                            "end_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "end_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):00$"},
                        },
                        "additionalProperties": False,
                    },
                    "desired_after": {
                        "type": "array", "minItems": 1, "maxItems": 40,
                        "items": {
                            "type": "object", "required": ["name", "quantity"],
                            "properties": {
                                "name": {"type": "string", "minLength": 1, "maxLength": 120},
                                "quantity": {"type": "integer", "minimum": 1, "maximum": 999},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "desired_period": {
                        "type": "object", "required": ["start_date", "start_time", "end_date", "end_time"],
                        "properties": {
                            "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "start_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):00$"},
                            "end_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                            "end_time": {"type": "string", "pattern": r"^(?:[01]\d|2[0-3]):00$"},
                        },
                        "additionalProperties": False,
                    },
                },
                "oneOf": [
                    {
                        "properties": {
                            "request_id": {"type": "string", "pattern": r"^RQ-\d{6}-\d{3}$"},
                        },
                        "not": {"required": ["pending_request_candidate"]},
                    },
                    {
                        "properties": {"request_id": {"type": "null"}},
                        "required": ["pending_request_candidate"],
                    },
                ],
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    },
}


CONFIRMATION_REQUEST_SCHEMA = enrich_confirmation_schema(CONFIRMATION_REQUEST_SCHEMA)
CONFIRMED_RESERVATION_COMMIT_SCHEMA = enrich_registration_schema(CONFIRMED_RESERVATION_COMMIT_SCHEMA)


def _build_adapter(config: Any) -> Any:
    """Construct the adapter only when Hermes enables this platform."""
    from .adapter import KakaoVillageAdapter

    return KakaoVillageAdapter(config)


def register_confirmation_tool(ctx: Any) -> None:
    """Register the native Village confirmation-request tool."""
    ctx.register_tool(
        name="village_confirmation_request",
        toolset="village",
        schema=CONFIRMATION_REQUEST_SCHEMA,
        handler=handle_confirmation_request,
        description=CONFIRMATION_REQUEST_SCHEMA["description"],
        emoji="📅",
    )


def register_document_tool(ctx: Any) -> None:
    """Register the native Village document execution tool."""
    ctx.register_tool(
        name="village_document_send",
        toolset="village",
        schema=DOCUMENT_SEND_SCHEMA,
        handler=handle_document_send,
        description=DOCUMENT_SEND_SCHEMA["description"],
        emoji="🧾",
    )


def register_registered_change_tool(ctx: Any) -> None:
    """Register the native staff-confirmed registered-change tool."""
    ctx.register_tool(
        name="village_registered_reservation_change",
        toolset="village",
        schema=REGISTERED_CHANGE_SCHEMA,
        handler=handle_registered_reservation_change,
        description=REGISTERED_CHANGE_SCHEMA["description"],
        emoji="🛠️",
    )


def register_confirmed_reservation_commit_tool(ctx: Any) -> None:
    """Register the native staff-authorized pending-registration tool."""
    ctx.register_tool(
        name="village_confirmed_reservation_commit",
        toolset="village",
        schema=CONFIRMED_RESERVATION_COMMIT_SCHEMA,
        handler=handle_confirmed_reservation_commit,
        description=CONFIRMED_RESERVATION_COMMIT_SCHEMA["description"],
        emoji="✅",
    )


def register(ctx: Any) -> None:
    """Register the Kakao platform and native Village tools."""
    ctx.register_platform(
        name="kakao_village",
        label="Kakao Village",
        adapter_factory=_build_adapter,
        check_fn=lambda: True,
        required_env=["VILLAGE_KAKAO_BRIDGE_URL", "VILLAGE_KAKAO_BRIDGE_TOKEN"],
    )
    register_confirmation_tool(ctx)
    register_document_tool(ctx)
    register_registered_change_tool(ctx)
    register_confirmed_reservation_commit_tool(ctx)
    ctx.register_tool(name="village_read",toolset="village",schema=READ_SCHEMA,
                      handler=handle_read,description=READ_SCHEMA["description"],emoji="🔎")
