"""Sierra tick/depth data -> original hftbacktest -> HFTENGINE replay.

Depth mode requires native recorded L2. Optional quotes mode uses native SCID
best bid/ask prices and explicitly assumes one contract at each best price.
Uses only Python's standard library. Feed latency is unknown and modeled as zero.
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EPOCH_US = 2_209_161_600_000_000
DEPTH_RECORD = struct.Struct("<qBBHfII")
TRADE_RECORD = struct.Struct("<qffffIIII")
EVENT = struct.Struct("<QqqddQqd")
DESCR = [("ev", "<u8"), ("exch_ts", "<i8"), ("local_ts", "<i8"),
         ("px", "<f8"), ("qty", "<f8"), ("order_id", "<u8"),
         ("ival", "<i8"), ("fval", "<f8")]
BUY, SELL = 1 << 29, 1 << 28
BOTH = (1 << 31) | (1 << 30)
TICK_MARKERS = {0.0, struct.unpack("<f", struct.pack("<f", -1.99900095e37))[0],
                struct.unpack("<f", struct.pack("<f", -1.99900197e37))[0]}
SOURCE_NOTE = ("Sierra recorded L2 depth plus individual classified trades. Recorded Sierra timestamps "
               "are used for both exchange and local events. Actual feed latency is unknown; zero feed "
               "latency is a modeling assumption, not a measurement. Order "
               "entry/response latency is separately modeled. Queue position is estimated "
               "from L2, not an observed individual-order queue. Complete depth batches precede "
               "trades at equal recorded timestamps because cross-stream ordering is unknown.")
QUOTES_SOURCE_NOTE = ("TOP-OF-BOOK SIMULATION ONLY, NOT A FULL L2 BACKTEST. Sierra native individual "
                      "tick trades and their saved best bid/ask prices are observed data. Bid/ask "
                      "quantities are ASSUMED ONE CONTRACT per side; no historical L2 quantities "
                      "are available. Queue positions and fills are modeled by hftbacktest and "
                      "cannot validate full-depth execution. Each record's trade precedes its "
                      "quote updates, including at equal timestamps. Recorded Sierra timestamps "
                      "are used for both exchange/local events; feed latency is unknown and "
                      "modeled as zero. Order entry/response latency is separately assumed.")


class DataError(ValueError):
    """Input cannot support the selected replay source."""


def open_source(file: Path):
    try:
        return file.open("rb")
    except FileNotFoundError as error:
        raise DataError(f"Missing Sierra data file: {file}") from error
    except PermissionError as error:
        raise DataError(f"Sierra is locking {file.name}. Use a completed readable copy, or retry after Sierra releases it.") from error


def header(file, magic: bytes, minimum: int, record_size: int, version_size: int):
    raw = file.read(minimum)
    if len(raw) != minimum or raw[:4] != magic:
        raise DataError(f"Not a supported {magic.decode()} Sierra file.")
    header_size, size = struct.unpack_from("<II", raw, 4)
    version = int.from_bytes(raw[12:12 + version_size], "little")
    if header_size != minimum or size != record_size or version != 1:
        raise DataError(f"Unsupported Sierra {magic.decode()} header/version/record size.")
    file.seek(0, 2)
    length = file.tell()
    count = (length - header_size) // size
    file.seek(header_size)
    return header_size, count


def ns(raw_time: int) -> int:
    value = (raw_time - EPOCH_US) * 1000
    if value <= 0 or value > 9_223_372_036_854_775_807:
        raise DataError("Invalid Sierra timestamp; expected integer microseconds since 1899-12-30.")
    return value


def price(value: float) -> float:
    if not math.isfinite(value) or value <= 0 or abs(value / 0.25 - round(value / 0.25)) > 1e-6:
        raise DataError("Invalid MNQ price or price off the 0.25-point tick grid.")
    return value


def event(kind: int, time: int, px: float = 0, qty: float = 0, side: int = 0):
    return BOTH | side | kind, time, time, px, qty, 0, 0, 0.0


def records(file, size: struct.Struct, count: int):
    """Bound reading to the file size at open, including while Sierra appends."""
    remaining = count
    while remaining:
        number = min(remaining, 32768)
        chunk = file.read(number * size.size)
        if len(chunk) != number * size.size:
            raise DataError("Sierra file changed/truncated while reading. Retry with a stable copy.")
        yield from size.iter_unpack(chunk)
        remaining -= number


def depth_events(file: Path, start: int, end: int, facts: dict):
    with open_source(file) as source:
        _, count = header(source, b"SCDD", 64, 24, 4)
        if not count:
            raise DataError("The Sierra .depth file only contains a header: no historical depth has been recorded. Record/download native market depth first.")
        bids, asks = {}, {}
        has_clear = False
        initialized = False
        covered_end = False
        previous = 0
        batch = []
        last_complete = None
        for raw_time, command, flags, orders, px, quantity, reserved in records(source, DEPTH_RECORD, count):
            time = ns(raw_time)
            if time < previous:
                raise DataError("Depth records are not chronological.")
            previous = time
            if flags & ~1 or command not in range(1, 8):
                raise DataError("Unsupported Sierra depth command/flags; refusing to guess.")
            if command != 1:
                price(px)
                if command < 6 and quantity == 0:
                    raise DataError("Zero-sized Sierra depth add/modify record.")
            batch.append((command, px, quantity))
            if len(batch) > 1000000:
                raise DataError("Depth batch has no end-of-batch marker.")
            if not flags & 1:
                continue
            last_complete = time
            # Only complete batches contribute to a usable book. Batch updates
            # are all applied at their final record's saved Sierra timestamp.
            if time > start and not initialized:
                if not has_clear or not bids or not asks or max(bids) >= min(asks):
                    raise DataError("No complete two-sided Sierra snapshot exists at the requested start. Choose a later start after a recorded clear/snapshot.")
                for p, q in sorted(bids.items(), reverse=True):
                    yield event(4, start, p, q, BUY)
                for p, q in sorted(asks.items()):
                    yield event(4, start, p, q, SELL)
                facts["initial_bid_levels"] = len(bids)
                facts["initial_ask_levels"] = len(asks)
                initialized = True
            if time >= end:
                covered_end = True
                break
            changes = []
            for command, px, quantity in batch:
                if command == 1:
                    bids.clear(); asks.clear(); has_clear = True
                    changes.append(event(3, time))
                    continue
                if not has_clear:
                    continue  # an incremental prefix cannot initialize a book
                side = BUY if command in (2, 4, 6) else SELL
                book = bids if side == BUY else asks
                if command in (6, 7):
                    book.pop(px, None)
                    quantity = 0
                else:
                    book[px] = quantity
                changes.append(event(1, time, px, quantity, side))
            if has_clear and bids and asks and max(bids) >= min(asks):
                raise DataError("Crossed depth book after a complete Sierra batch. Check source and tick/price scaling.")
            if time > start and initialized:
                facts["depth_batches"] += 1
                facts["depth_records"] += len(batch)
                yield from changes
            batch = []
        if not initialized:
            raise DataError("No recorded snapshot and depth updates overlap the requested interval.")
        if not covered_end:
            suffix = f" Last complete depth batch: {datetime.fromtimestamp(last_complete / 1e9, timezone.utc).isoformat()}." if last_complete else ""
            raise DataError("The requested end is beyond completed depth coverage. Choose an earlier start or shorter interval." + suffix)
        if not facts["depth_batches"]:
            raise DataError("No recorded depth updates overlap the requested interval.")


def trade_events(file: Path, start: int, end: int, facts: dict):
    with open_source(file) as source:
        offset, count = header(source, b"SCID", 56, 40, 2)
        if not count:
            raise DataError("The Sierra .scid file has no trade records.")
        def time_at(index):
            source.seek(offset + index * 40)
            raw = source.read(8)
            if len(raw) != 8:
                raise DataError("Trade file changed while seeking. Retry with a stable copy.")
            return ns(struct.unpack("<q", raw)[0])
        if time_at(count - 1) < end:
            raise DataError("The requested end is beyond recorded trade coverage. Choose an earlier or shorter interval.")
        lo, hi = 0, count
        while lo < hi:
            middle = (lo + hi) // 2
            if time_at(middle) < start:
                lo = middle + 1
            else:
                hi = middle
        source.seek(offset + lo * 40)
        previous = start
        for raw_time, op, hi, low, close, number, volume, bid_volume, ask_volume in records(source, TRADE_RECORD, count - lo):
            time = ns(raw_time)
            if time < previous:
                raise DataError("Trade records are not chronological.")
            previous = time
            if time >= end:
                break
            if not volume:
                continue  # bid/ask-only update; contains no executed trade
            if number != 1 or op not in TICK_MARKERS:
                raise DataError("Queue backtesting requires individual Sierra tick records. An aggregated .scid record was found; use 1 Tick Intraday Data Storage Time Unit and redownload the interval.")
            price(close)
            if ask_volume == volume and bid_volume == 0:
                side = BUY
            elif bid_volume == volume and ask_volume == 0:
                side = SELL
            else:
                raise DataError("A trade has unknown/ambiguous aggressor side. Refusing to guess buyer/seller or discard trades for a queue backtest.")
            facts["trade_records"] += 1
            yield event(2, time, close, volume, side)
        if not facts["trade_records"]:
            raise DataError("No individual trades overlap the requested depth interval.")


def quote_events(file: Path, start: int, end: int, facts: dict):
    """Replay tick trades first, then that tick's saved quotes with assumed size 1.

    Sierra single-trade records store ask in High and bid in Low. These are
    prices, never displayed depth quantities. No preceding record or subsequent
    record is used to backfill a quote at the requested start.
    """
    with open_source(file) as source:
        offset, count = header(source, b"SCID", 56, 40, 2)
        if not count:
            raise DataError("The Sierra .scid file has no trade records.")

        def time_at(index):
            source.seek(offset + index * TRADE_RECORD.size)
            raw = source.read(8)
            if len(raw) != 8:
                raise DataError("Trade file changed while seeking. Retry with a stable copy.")
            return ns(struct.unpack("<q", raw)[0])

        if time_at(count - 1) < end:
            raise DataError("The requested end is beyond recorded trade coverage. Choose an earlier or shorter interval.")
        lo, hi = 0, count
        while lo < hi:
            middle = (lo + hi) // 2
            if time_at(middle) < start:
                lo = middle + 1
            else:
                hi = middle
        source.seek(offset + lo * TRADE_RECORD.size)
        previous = start
        old_bid = old_ask = None
        for raw_time, op, ask, bid, close, number, volume, bid_volume, ask_volume in records(source, TRADE_RECORD, count - lo):
            time = ns(raw_time)
            if time < previous:
                raise DataError("Trade records are not chronological.")
            previous = time
            if time >= end:
                break
            if not volume:
                continue
            if number != 1 or op not in TICK_MARKERS:
                raise DataError("Quote simulation requires individual Sierra tick records. An aggregated .scid record was found; use 1 Tick Intraday Data Storage Time Unit and redownload the interval.")
            price(close)
            try:
                price(bid); price(ask)
            except DataError as error:
                raise DataError("Quote simulation requires valid saved native bid/ask prices in every tick record. Missing/off-grid quotes cannot be reconstructed from trade prices.") from error
            if bid >= ask:
                raise DataError("Quote simulation requires a noncrossed, unlocked native bid/ask in every tick record.")
            if ask_volume == volume and bid_volume == 0:
                side = BUY
            elif bid_volume == volume and ask_volume == 0:
                side = SELL
            else:
                raise DataError("A trade has unknown/ambiguous aggressor side. Refusing to guess buyer/seller for a quote simulation.")

            facts["trade_records"] += 1
            facts["quote_records"] += 1
            # Preserve causality: orders resting on the previous known quote
            # see the trade before receiving this record's quote observation.
            yield event(2, time, close, volume, side)
            if old_bid is None:
                facts["first_quote_ns"] = str(time)
                facts["initial_bid_levels"] = 1
                facts["initial_ask_levels"] = 1
                yield event(4, time, bid, 1, BUY)
                yield event(4, time, ask, 1, SELL)
            else:
                if old_bid != bid:
                    yield event(1, time, old_bid, 0, BUY)
                if old_ask != ask:
                    yield event(1, time, old_ask, 0, SELL)
                # New quantities are assumptions, never the trade's volume.
                yield event(1, time, bid, 1, BUY)
                yield event(1, time, ask, 1, SELL)
            if old_bid != bid or old_ask != ask:
                facts["quote_changes"] += 1
            old_bid, old_ask = bid, ask
        if not facts["trade_records"]:
            raise DataError("No individual trades with native bid/ask quotes overlap the requested interval.")


def npy_header(count: int) -> bytes:
    raw = repr({"descr": DESCR, "fortran_order": False, "shape": (count,)}).encode("ascii")
    padding = (-(10 + len(raw) + 1)) % 64
    raw += b" " * padding + b"\n"
    return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(raw)) + raw


def prepare(depth: Path | None, trades: Path, start: int, end: int, output: Path, source_mode: str = "depth", symbol: str | None = None):
    if source_mode not in ("depth", "quotes"):
        raise DataError("Source must be depth or quotes.")
    if source_mode == "quotes" and (end <= start or end - start > 60 * 60 * 1_000_000_000):
        raise DataError("Quote simulation windows must be positive and no longer than 60 minutes.")
    facts = {"source": "Sierra Chart native recorded depth and ticks", "source_note": SOURCE_NOTE,
             "depth_file": str(depth), "trade_file": str(trades), "first_ns": str(start),
             "last_ns_exclusive": str(end), "depth_batches": 0, "depth_records": 0,
             "trade_records": 0, "initial_bid_levels": 0, "initial_ask_levels": 0,
             "feed_latency_ns": 0, "feed_latency_measured": False,
             "timestamp_basis": "recorded Sierra timestamps; exchange/local set equal, actual feed latency unknown",
             "batch_timestamp_policy": "all commands at final batch record Sierra timestamp",
             "equal_timestamp_policy": "depth batch before trades; cross-stream ordering unavailable"}
    if symbol is not None:
        if not re.fullmatch(r"MNQ[HMUZ]\d{2}-CME", symbol):
            raise DataError("Invalid MNQ contract identity.")
        facts["symbol"] = symbol
    facts["source_mode"] = source_mode
    facts["full_depth"] = source_mode == "depth"
    if source_mode == "quotes":
        facts.update({"source": "Sierra Chart native tick trades and top-of-book quote prices; assumed one-contract quantities",
                      "source_note": QUOTES_SOURCE_NOTE, "depth_file": None, "quotes_modeled": True,
                      "assumed_quote_quantity": 1, "queue_and_fills_modeled": True,
                      "quote_records": 0, "quote_changes": 0,
                      "batch_timestamp_policy": "single trade record timestamp; no L2 depth batches",
                      "equal_timestamp_policy": "each tick trade before its own quote updates; source record ordering preserved"})
    elif depth is None:
        raise DataError("A native depth file is required for depth mode.")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Raw event bytes are spooled, keeping memory bounded without NumPy.
    # The archive is installed atomically only after both sources validate.
    with tempfile.TemporaryFile(dir=output.parent) as raw:
        count = 0
        if source_mode == "quotes":
            with closing(quote_events(trades, start, end, facts)) as quotes:
                for row in quotes:
                    raw.write(EVENT.pack(*row)); count += 1
        else:
            with closing(depth_events(depth, start, end, facts)) as d, closing(trade_events(trades, start, end, facts)) as t:
                for row in heapq.merge(d, t, key=lambda row: row[1]):
                    raw.write(EVENT.pack(*row)); count += 1
        if not count:
            raise DataError("No overlapping depth and trade events are available.")
        raw.seek(0)
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".npz", delete=False) as target:
            temporary = Path(target.name)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
                with archive.open("data.npy", "w", force_zip64=True) as data:
                    data.write(npy_header(count))
                    shutil.copyfileobj(raw, data)
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    facts["npz"] = {"file": output.name, "bytes": output.stat().st_size, "rows": count,
                    "feed_latency_ms_p50": 0, "feed_latency_ms_p90": 0, "feed_latency_ms_p99": 0}
    return facts


def utc_window(date: str, start: str, minutes: float):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or not re.fullmatch(r"\d{2}:\d{2}", start):
        raise DataError("Date/start must be YYYY-MM-DD and HH:MM UTC.")
    if not math.isfinite(minutes) or not 1 <= minutes <= 240:
        raise DataError("Minutes must be between 1 and 240.")
    try:
        beginning = datetime.strptime(f"{date} {start}", "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise DataError("Invalid UTC date or start time.") from error
    finish = beginning + timedelta(minutes=minutes)
    if finish.date() != beginning.date() and finish.time().isoformat() != "00:00:00":
        raise DataError("Choose a window within one UTC date; each .depth file covers one date.")
    return int(beginning.timestamp()) * 1_000_000_000, int(finish.timestamp() * 1_000_000) * 1000


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True)
    parser.add_argument("--start", default="00:00", help="UTC HH:MM")
    parser.add_argument("--minutes", type=float, default=30, help="Historical window in minutes (default: 30; quote simulation maximum: 60)")
    parser.add_argument("--name", default=None)
    parser.add_argument("--symbol", default="MNQZ26-CME")
    parser.add_argument("--data-folder", type=Path, default=(ROOT.parent / "SierraChart" / "Data"))
    parser.add_argument("--depth-file", type=Path)
    parser.add_argument("--trade-file", type=Path)
    parser.add_argument("--fee-per-contract", type=float, default=0.75)
    parser.add_argument("--latency-us", default="10000,10000", help="Modeled order entry,response microseconds")
    parser.add_argument("--strategy", choices=("queue", "grid", "ema"), default="queue")
    parser.add_argument("--source", choices=("depth", "quotes"), default="depth",
                        help="depth requires native recorded L2; quotes simulates one assumed contract at each native best bid/ask")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args(argv)
    if args.strategy == 'ema' and args.minutes < 22:
        raise DataError("EMA needs at least 22 minutes: the first 21 completed one-minute trade bars warm up the averages. Start with 30 minutes.")
    start, end = utc_window(args.date, args.start, args.minutes)
    if args.source == "quotes" and args.minutes > 60:
        raise DataError("Quote simulation is limited to 60 minutes per session.")
    if not re.fullmatch(r"MNQ[A-Z]\d{2}-CME", args.symbol):
        raise DataError("This converter is configured for an MNQ contract, for example MNQZ26-CME.")
    name = args.name or f"mnq_{args.date.replace('-', '')}_{args.start.replace(':', '')}_{args.strategy}"
    if args.source == "quotes" and args.name is None:
        name += "_quotes"
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", name):
        raise DataError("Session name must use 1–80 letters, numbers, underscores or hyphens.")
    if not math.isfinite(args.fee_per_contract) or not 0 <= args.fee_per_contract <= 100:
        raise DataError("Fee per contract must be between $0 and $100 per side.")
    if not re.fullmatch(r"\d+,\d+", args.latency_us) or any(int(x) > 1_000_000 for x in args.latency_us.split(",")):
        raise DataError("Latency must be entry,response whole microseconds, each between 0 and 1000000.")
    depth = args.depth_file or args.data_folder / "MarketDepthData" / f"{args.symbol}.{args.date}.depth"
    trades = args.trade_file or args.data_folder / f"{args.symbol}.scid"
    normalized = ROOT / "data" / "npz" / f"{name}.npz"
    facts = prepare(depth, trades, start, end, normalized, args.source, symbol=args.symbol)
    facts["modeled_order_latency_us"] = [int(x) for x in args.latency_us.split(",")]
    facts["strategy"] = args.strategy
    facts_file = normalized.with_suffix(".sierra.json")
    facts_file.write_text(json.dumps(facts, indent=2), encoding="utf-8")
    if args.prepare_only:
        print(json.dumps({"prepared": str(normalized), "facts": str(facts_file), "events": facts["npz"]["rows"]}))
        return
    runner = ROOT / "runner" / "target" / "release" / "hftengine-runner.exe"
    if not runner.is_file():
        raise DataError("The original hftbacktest runner is not built yet. The validated feed has been prepared; build runner with cargo build --release.")
    out = ROOT / "data" / "recordings" / f"{name}.hbr"
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [str(runner), "--data", str(normalized), "--const-latency-us", args.latency_us,
               "--symbol", args.symbol, "--exchange", "CME", "--contract-size", "2",
               "--fee-per-contract", str(args.fee_per_contract), "--tick-size", "0.25",
               "--lot-size", "1", "--order-qty", "1", "--max-position", "1", "--grid-num", "1",
               "--queue-model", "riskadverse", "--strategy", args.strategy,
               "--source-note", facts["source_note"], "--out", str(out)]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if completed.stdout:
        print(completed.stdout, file=sys.stderr, end="")
    if completed.returncode:
        raise DataError(f"hftbacktest runner failed: {completed.stderr.strip()[-3000:]}")
    with out.open("rb") as recording:
        preamble = recording.read(12)
        if preamble[:8] != b"HFTREC01":
            raise DataError("Runner produced an invalid recording; it was not staged.")
        length = struct.unpack_from("<I", preamble, 8)[0]
        if length > 10_000_000:
            raise DataError("Runner recording header is unexpectedly large.")
        metadata = json.loads(recording.read(length))["meta"]
    frames = metadata.get("n_frames", 0)
    if not isinstance(frames, int) or frames < 2:
        raise DataError("Runner produced too few frames to replay; it was not staged.")
    destination = ROOT / "dashboard" / "public" / "sessions"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(out, destination / out.name)
    shutil.copyfile(facts_file, destination / f"{name}.sierra.json")
    print(json.dumps({"session": name, "url": f"/?session={name}", "frames": frames}))


if __name__ == "__main__":
    try:
        main()
    except (DataError, OSError, ValueError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
