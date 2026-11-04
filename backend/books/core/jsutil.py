"""Small helpers that reproduce JavaScript semantics the original Node code relied on."""
import datetime
import math


def jsnum(v, default=0):
    """`Number(v) || default`: numbers pass through, numeric strings parse, booleans -> 1/0,
    None / '' / NaN / unparsable -> default (0 by default)."""
    n = num_or_none(v)
    if n is None or n == 0:
        return default
    return n


def num_or_none(v):
    """`Number(v)` where NaN/'' should count as missing (returns None)."""
    if v is None or v == '':
        return None
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return None if isinstance(v, float) and math.isnan(v) else v
    try:
        f = float(str(v).strip())
        return None if math.isnan(f) else (int(f) if f.is_integer() else f)
    except ValueError:
        return None


def truthy(v):
    """JavaScript truthiness (empty list/dict are truthy, '0' is truthy, NaN is falsy)."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or (isinstance(v, float) and math.isnan(v)))
    if isinstance(v, str):
        return v != ''
    return True


def jsstr(v):
    """String(number) as JavaScript prints it (18.0 -> '18', 2.5 -> '2.5')."""
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if v is None:
        return 'null'
    if isinstance(v, float):
        if math.isnan(v):
            return 'NaN'
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    return str(v)


def to_fixed2(v):
    """Number.prototype.toFixed(2)."""
    return f'{jsnum(v):.2f}'


def now_iso():
    """new Date().toISOString()"""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def today():
    """new Date().toISOString().slice(0, 10) (UTC date)."""
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def to_int(v, default=None):
    """Number(v) for ids coming from URLs/bodies (returns default if not a number)."""
    n = num_or_none(v)
    if n is None:
        return default
    return int(n) if float(n).is_integer() else n
