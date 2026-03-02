"""
Barcode resolver service for POS Next.

This module provides an optional integration with the barcode_resolver app.
When barcode_resolver is installed, it enables advanced barcode parsing
for weighted and priced barcodes. When not installed, it gracefully
returns None.

Usage:
    from pos_next.services import resolve_barcode, is_barcode_resolver_available

    # Check if feature is available
    if is_barcode_resolver_available():
        result = resolve_barcode("2001234001234")
        if result:
            print(result["item_barcode"], result["qty"])

    # Or simply call resolve_barcode (returns None if app not installed)
    result = resolve_barcode("2001234001234")
"""

from __future__ import annotations

from functools import lru_cache
from typing import List, TypedDict

import frappe
from erpnext.stock.get_item_details import get_conversion_factor


class BarcodeResult(TypedDict, total=False):
    """Type definition for barcode resolution result."""

    item_barcode: str  # The barcode from Item Barcodes table
    integer_value: str  # Integer part of the encoded value
    decimal_value: str  # Decimal part of the encoded value
    barcode_type: str  # "Weighted" or "Priced"
    uom: str | None  # UOM from Item Barcodes table
    qty: float | None  # Quantity (only for weighted barcodes)


class ResolvedItemData(TypedDict, total=False):
    """Type definition for resolved item data to be applied to cart."""

    resolved_qty: float | None
    resolved_uom: str | None
    resolved_price: float | None
    resolved_barcode_type: str | None


@lru_cache(maxsize=1)
def is_barcode_resolver_available() -> bool:
    """
    Check if the barcode_resolver app is installed.

    Returns:
        bool: True if barcode_resolver is available, False otherwise.

    Note:
        Result is cached for performance. Server restart clears the cache.
    """
    return "barcode_resolver" in frappe.get_installed_apps()


def resolve_barcode(barcode: str, pos_profile: str) -> BarcodeResult | None:
    """
    Resolve a barcode using the barcode_resolver app if available.

    This function attempts to parse special barcode formats (weighted/priced)
    using configurable rules from the barcode_resolver app.
    If no rule matches (or the app is not installed), it falls back to a
    simple built-in pattern used by many scales.

    Args:
        barcode: The barcode string to resolve.

    Returns:
        BarcodeResult dict if the barcode matches a rule, None otherwise.
        Also returns None if barcode_resolver app is not installed.

    Example:
        >>> result = resolve_barcode("2001234001500")
        >>> if result:
        ...     print(f"Item: {result['item_barcode']}, Qty: {result['qty']}")
    """
    resolved: BarcodeResult | None = None

    # 1) Try barcode_resolver app if available
    if is_barcode_resolver_available():
        try:
            from barcode_resolver.barcode_resolver.doctype.barcode_rule.utils import (
                resolve_barcode as _resolve_barcode,
            )
            # get POS Settings
            pos_settings = frappe.get_doc("POS Settings", {"pos_profile": pos_profile})
            barcode_rules = [
                rule.barcode_rule
                for rule in pos_settings.barcode_rules
                if not rule.disable
            ]
            resolved = _resolve_barcode(barcode, barcode_rules)
        except ImportError:
            # App might have been uninstalled, clear cache and continue to fallbacks
            is_barcode_resolver_available.cache_clear()
            resolved = None
        except Exception:
            # Log unexpected errors but don't break POS functionality
            frappe.log_error(
                title="Barcode Resolver Error",
                message=f"Error resolving barcode: {barcode}",
            )
            resolved = None

    if resolved:
        return resolved

    # 2) Built-in fallback: 13-digit weighted barcode starting with '20'
    #    Example: 2000010002573
    #    - '20'      -> variable flag
    #    - '00010'   -> embedded item barcode
    #    - next 1    -> check digit (ignored)
    #    - next 4    -> weight * 100 (e.g. 0257 -> 2.57)
    #    - last 1    -> check digit (ignored)
    try:
        code = (barcode or "").strip()
        if len(code) == 13 and code.startswith("20"):
            item_barcode = code[2:7]
            weight_digits = code[8:12]

            if not weight_digits.isdigit():
                return None

            weight_int = int(weight_digits)
            qty = weight_int / 100.0
            qty_str = f"{qty:.2f}"
            integer_value, decimal_value = qty_str.split(".")

            return {
                "item_barcode": item_barcode,
                "integer_value": integer_value,
                "decimal_value": decimal_value,
                "barcode_type": "Weighted",
                "qty": qty,
            }
    except Exception:
        frappe.log_error(
            title="Fallback Barcode Parse Error",
            message=f"Error parsing embedded barcode: {barcode}",
        )

    return None


def compute_resolved_item_data(
    resolved_barcode: BarcodeResult | None,
    item,
) -> ResolvedItemData | None:
    """
    Compute qty and uom from resolved barcode data.

    For weighted barcodes: uses qty directly from the barcode.
    For priced barcodes: computes qty = encoded_price / item_rate.

    Args:
        resolved_barcode: The result from resolve_barcode().
        item_rate: The item's unit price (required for priced barcodes).

    Returns:
        ResolvedItemData with resolved_qty, resolved_uom, and resolved_barcode_type,
        or None if no valid resolution.

    Example:
        >>> resolved = resolve_barcode("2001234001500")
        >>> if resolved:
        ...     item_data = compute_resolved_item_data(resolved, item_rate=10.0)
        ...     print(f"Qty: {item_data['resolved_qty']}, UOM: {item_data['resolved_uom']}")
    """
    if not resolved_barcode:
        return None

    # Try to import BarcodeTypes from barcode_resolver when available.
    # If not available, fall back to simple string values so built-in
    # fallback patterns (e.g. "Weighted") still work.
    try:
        from barcode_resolver.barcode_resolver.doctype.barcode_rule.utils import BarcodeTypes

        TYPE_WEIGHTED = BarcodeTypes.WEIGHTED.value
        TYPE_PRICED = BarcodeTypes.PRICED.value
    except Exception:
        TYPE_WEIGHTED = "Weighted"
        TYPE_PRICED = "Priced"

    barcode_type = resolved_barcode.get("barcode_type")
    barcode_uom = resolved_barcode.get("uom")
    # If barcode resolver didn't provide a UOM, fall back to item's stock UOM
    if not barcode_uom:
        barcode_uom = item.get("uom")
    uom_prices = item.get("uom_prices", {})
    barcode_uom_price = uom_prices.get(barcode_uom)
    item_uom = item.get("uom")
    item_price = item.get("rate")
    item_name = item.get("item_code")
    if item_name is None:
        frappe.log_error(
            title="Barcode Resolver Error",
            message=f"Item code is missing in item data: {item}",
        )
        return None

    integer_value = resolved_barcode.get("integer_value", "0")
    decimal_value = resolved_barcode.get("decimal_value", "0")
    if barcode_type == TYPE_WEIGHTED:
        qty = float(f"{integer_value}.{decimal_value}")
        uom = barcode_uom
        price = barcode_uom_price
        if barcode_uom not in uom_prices:
            conversion_factor = get_conversion_factor(item_name, barcode_uom).get("conversion_factor", 1)
            qty *= conversion_factor
            uom = item_uom
            price = item_price

        return {
            "resolved_qty": qty,
            "resolved_uom": uom,
            "resolved_price": price,
            "resolved_barcode_type": barcode_type,
        }
    elif barcode_type == TYPE_PRICED:
        encoded_price = float(f"{integer_value}.{decimal_value}")
        if barcode_uom in uom_prices:
            barcode_uom_price = uom_prices.get(barcode_uom)
            price = barcode_uom_price
            uom = barcode_uom
            qty = encoded_price / price if price and price > 0 else None
        else:
            conversion_factor = get_conversion_factor(item_name, barcode_uom).get("conversion_factor", 1)
            uom = barcode_uom
            price = conversion_factor * item_price
            # Add the calculated price as this barcode_uom price
            uom_prices[barcode_uom] = price
            qty = encoded_price / price if price and price > 0 else None
        return {
            "resolved_qty": qty,
            "resolved_uom": uom,
            "resolved_price": encoded_price,
            "resolved_barcode_type": barcode_type,
        }

    return None
