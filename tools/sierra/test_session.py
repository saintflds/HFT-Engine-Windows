"""Focused synthetic format tests; fixtures never become real MNQ sessions."""
import ast
import importlib.util
import json
import struct
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sierra_session", Path(__file__).with_name("session.py"))
session = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(session)


def depth_record(time, command, flags=1, px=0, qty=0):
    return session.DEPTH_RECORD.pack(time // 1000 + session.EPOCH_US, command, flags, 1, px, qty, 0)


def trade_record(time, px=29000.25, volume=2, bid=0, ask=2, op=0, number=1):
    return session.TRADE_RECORD.pack(time // 1000 + session.EPOCH_US, op, px + .25, px - .25, px, number, volume, bid, ask)


def header(magic, size, record):
    result = bytearray(size)
    struct.pack_into("<4sIII", result, 0, magic, size, record, 1)
    return result


class SierraSessionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.depth = self.path / "MNQZ26-CME.2026-10-23.depth"
        self.trades = self.path / "MNQZ26-CME.scid"
        self.output = self.path / "fixture.npz"
        self.start, self.end = session.utc_window("2026-10-23", "14:00", 1)
        self.depth_rows = [depth_record(self.start - 1_000_000_000, 1, 0),
                           depth_record(self.start - 1_000_000_000, 2, 0, 29000, 10),
                           depth_record(self.start - 1_000_000_000, 3, 1, 29000.25, 12),
                           depth_record(self.start + 1_000_000_000, 4, 1, 29000, 8),
                           depth_record(self.start + 2_000_000_000, 7, 0, 29000.25),
                           depth_record(self.start + 2_000_000_000, 3, 1, 29000.50, 5),
                           depth_record(self.end, 5, 1, 29000.50, 6)]
        self.trade_rows = [trade_record(self.start + 1_500_000_000),
                           trade_record(self.start + 3_000_000_000, px=29000, volume=3, bid=3, ask=0),
                           trade_record(self.end + 1_000_000_000)]
        self.write()

    def write(self):
        self.depth.write_bytes(header(b"SCDD", 64, 24) + b"".join(self.depth_rows))
        self.trades.write_bytes(header(b"SCID", 56, 40) + b"".join(self.trade_rows))

    def prepare(self):
        return session.prepare(self.depth, self.trades, self.start, self.end, self.output)

    def load(self):
        with zipfile.ZipFile(self.output) as archive:
            raw = archive.read("data.npy")
        self.assertEqual(raw[:8], b"\x93NUMPY\x01\x00")
        length = struct.unpack_from("<H", raw, 8)[0]
        self.assertEqual((10 + length) % 64, 0)
        meta = ast.literal_eval(raw[10:10 + length].decode("ascii").strip())
        self.assertEqual(meta["descr"], session.DESCR)
        self.assertFalse(meta["fortran_order"])
        rows = list(session.EVENT.iter_unpack(raw[10 + length:]))
        self.assertEqual(meta["shape"], (len(rows),))
        return rows

    def test_native_depth_snapshot_changes_and_aggressor_trades(self):
        facts = self.prepare()
        rows = self.load()
        self.assertEqual(len(rows), 7)
        self.assertEqual(facts["trade_records"], 2)
        self.assertEqual(facts["depth_batches"], 2)
        self.assertEqual(rows[0], session.event(4, self.start, 29000, 10, session.BUY))
        self.assertEqual(rows[1], session.event(4, self.start, 29000.25, 12, session.SELL))
        self.assertTrue(all(row[0] & session.BOTH == session.BOTH for row in rows))
        self.assertTrue(all(row[1] == row[2] for row in rows))
        self.assertEqual([row[1] for row in rows], sorted(row[1] for row in rows))
        trades = [row for row in rows if row[0] & 255 == 2]
        self.assertEqual(trades[0][0] & session.BUY, session.BUY)
        self.assertEqual(trades[1][0] & session.SELL, session.SELL)
        self.assertFalse(facts["feed_latency_measured"])
        self.assertEqual(rows[-3][4], 0)  # actual recorded delete

    def test_empty_depth_refuses_without_creating_output(self):
        self.depth.write_bytes(header(b"SCDD", 64, 24))
        with self.assertRaisesRegex(session.DataError, "only contains a header"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_missing_snapshot_refuses(self):
        self.depth_rows = self.depth_rows[1:]
        self.write()
        with self.assertRaisesRegex(session.DataError, "snapshot"):
            self.prepare()

    def test_aggregated_and_unclassified_trades_refuse(self):
        for kwargs, message in [({"number": 2}, "aggregated"), ({"bid": 1, "ask": 1}, "ambiguous")]:
            with self.subTest(kwargs=kwargs):
                self.trade_rows[0] = trade_record(self.start + 1_500_000_000, **kwargs)
                self.write()
                with self.assertRaisesRegex(session.DataError, message):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_unbundled_trade_flags_are_exact(self):
        self.trade_rows[0] = trade_record(self.start + 1_500_000_000, op=-1.99900095e37)
        self.write()
        self.assertEqual(self.prepare()["trade_records"], 2)

    def test_missing_depth_end_coverage_refuses(self):
        self.depth_rows.pop()
        self.write()
        with self.assertRaisesRegex(session.DataError, "beyond completed depth coverage"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_partial_batch_does_not_satisfy_coverage(self):
        self.depth_rows[-1] = depth_record(self.end, 5, 0, 29000.50, 6)
        self.write()
        with self.assertRaisesRegex(session.DataError, "beyond completed depth coverage"):
            self.prepare()

    def test_equal_timestamps_are_ordered_depth_before_trade(self):
        self.trade_rows[0] = trade_record(self.start + 1_000_000_000)
        self.write()
        self.prepare()
        same_time = [row[0] & 255 for row in self.load() if row[1] == self.start + 1_000_000_000]
        self.assertEqual(same_time, [1, 2])

    def test_unknown_commands_and_crossed_book_refuse(self):
        for record, message in [(depth_record(self.start + 1_000_000_000, 9), "command"),
                                (depth_record(self.start + 1_000_000_000, 4, 1, 29001, 5), "Crossed")]:
            with self.subTest(message=message):
                self.depth_rows[3] = record
                self.write()
                with self.assertRaisesRegex(session.DataError, message):
                    self.prepare()

    def test_date_window_validation(self):
        for date, clock, minutes in [("2026-02-30", "14:00", 1), ("2026-10-23", "24:00", 1),
                                     ("2026-10-23", "23:59", 2), ("2026-10-23", "14:00", float("nan"))]:
            with self.assertRaises(session.DataError):
                session.utc_window(date, clock, minutes)

    def test_quotes_mode_needs_no_depth_and_uses_assumed_one_contract(self):
        self.depth.unlink()
        facts = session.prepare(None, self.trades, self.start, self.end, self.output, "quotes")
        rows = self.load()
        self.assertEqual(facts["source_mode"], "quotes")
        self.assertFalse(facts["full_depth"])
        self.assertEqual(facts["assumed_quote_quantity"], 1)
        self.assertIn("NOT A FULL L2 BACKTEST", facts["source_note"])
        self.assertEqual(facts["quote_records"], 2)
        self.assertEqual(facts["trade_records"], 2)
        self.assertEqual(facts["first_quote_ns"], str(self.start + 1_500_000_000))
        self.assertTrue(all(row[1] >= self.start + 1_500_000_000 for row in rows), "initial quotes must not be backfilled before observation")
        self.assertEqual([row[0] & 255 for row in rows[:3]], [2, 4, 4])
        self.assertEqual([row[3:5] for row in rows[1:3]], [(29000, 1), (29000.50, 1)])
        self.assertEqual(rows[0][4], 2, "executed volume must be preserved separately")
        self.assertTrue(all(row[4] in (0, 1) for row in rows if row[0] & 255 in (1, 4)))

    def test_quotes_mode_preserves_trade_before_own_quotes_at_ties(self):
        self.trade_rows[1] = trade_record(self.start + 1_500_000_000, px=29000, volume=3, bid=3, ask=0)
        self.write()
        session.prepare(None, self.trades, self.start, self.end, self.output, "quotes")
        rows = self.load()
        self.assertEqual([row[0] & 255 for row in rows], [2, 4, 4, 2, 1, 1, 1, 1])
        self.assertEqual(rows[3][4], 3)
        self.assertEqual([row[4] for row in rows[4:]], [0, 0, 1, 1])

    def test_quotes_mode_refuses_aggregates_unknown_side_and_missing_quotes(self):
        for row, message in [
            (trade_record(self.start + 1_500_000_000, number=2), "aggregated"),
            (trade_record(self.start + 1_500_000_000, bid=1, ask=1), "ambiguous"),
            (session.TRADE_RECORD.pack((self.start + 1_500_000_000) // 1000 + session.EPOCH_US,
                                       0, 0, 0, 29000, 1, 1, 0, 1), "valid saved native bid/ask"),
            (session.TRADE_RECORD.pack((self.start + 1_500_000_000) // 1000 + session.EPOCH_US,
                                       0, 29000, 29000.25, 29000, 1, 1, 0, 1), "noncrossed"),
        ]:
            with self.subTest(message=message):
                self.trade_rows[0] = row
                self.write()
                with self.assertRaisesRegex(session.DataError, message):
                    session.prepare(None, self.trades, self.start, self.end, self.output, "quotes")
                self.assertFalse(self.output.exists())

    def test_quotes_mode_enforces_coverage_and_window_limit(self):
        with self.assertRaisesRegex(session.DataError, "60 minutes"):
            session.prepare(None, self.trades, self.start, self.start + 61 * 60 * 1_000_000_000, self.output, "quotes")
        self.trade_rows.pop()
        self.write()
        with self.assertRaisesRegex(session.DataError, "beyond recorded trade coverage"):
            session.prepare(None, self.trades, self.start, self.end, self.output, "quotes")
        self.assertFalse(self.output.exists())

    @unittest.skipUnless((session.ROOT / "runner/target/release/hftengine-runner.exe").is_file(), "original Rust runner not built")
    def test_original_runner_accepts_event64_and_records_mnq_contract_settings(self):
        self.prepare()
        out = self.path / "synthetic-format-fixture.hbr"
        runner = session.ROOT / "runner/target/release/hftengine-runner.exe"
        command = [str(runner), "--data", str(self.output), "--out", str(out),
                   "--symbol", "SYNTHETIC-FORMAT-TEST", "--exchange", "TEST FIXTURE",
                   "--const-latency-us", "10000,10000", "--tick-size", ".25", "--lot-size", "1",
                   "--contract-size", "2", "--fee-per-contract", ".75", "--order-qty", "1",
                   "--max-position", "1", "--grid-num", "1", "--strategy", "queue",
                   "--source-note", "Synthetic format compatibility test only; never a real MNQ session."]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        raw = out.read_bytes()
        self.assertEqual(raw[:8], b"HFTREC01")
        size = struct.unpack_from("<I", raw, 8)[0]
        metadata = json.loads(raw[12:12 + size])["meta"]
        self.assertGreater(metadata["n_frames"], 1)
        self.assertEqual(metadata["contract_size"], 2)
        self.assertEqual(metadata["models"]["fee"]["kind"], "TradingQtyFeeModel")
        self.assertEqual(metadata["models"]["fee"]["maker"], .75)
        self.assertEqual(metadata["models"]["fee"]["taker"], .75)


if __name__ == "__main__":
    unittest.main()
