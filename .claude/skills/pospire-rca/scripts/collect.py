#!/usr/bin/env python3
"""Collect a read-only POSpire RCA evidence bundle — locally or over REST.

The bundle is built server-side by `pospire.pospire.api.diagnostics`; this
script is a thin client for it.

LOCAL (bench on this machine, DB running) — run from the bench `sites/` dir:

    cd <bench>/sites
    ../env/bin/python ../apps/pospire/.claude/skills/pospire-rca/scripts/collect.py \
        --site pospire.localhost --invoice ACC-SINV-2026-00042

REMOTE (production, no shell / MCP needed) — any python3, no dependencies:

    export POSPIRE_RCA_URL=https://pos.example.com
    export POSPIRE_RCA_API_KEY=... POSPIRE_RCA_API_SECRET=...
    python3 collect.py --remote --invoice ACC-SINV-2026-00042

    The API user needs the `POSpire RCA Reader` role (or System Manager).

Identify the incident with any of:
    --offline-id --invoice --review --device-id --user --shift
or use --fleet for a fleet-wide health snapshot.
Time window: --since / --until (YYYY-MM-DD[ HH:MM[:SS]]), default last 24h,
capped at 31 days.

Output is JSON on stdout (or --out FILE). It contains customer data —
review before sharing.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

METHOD = "pospire.pospire.api.diagnostics.get_rca_bundle"
ID_ARGS = ("offline_id", "invoice", "review", "device_id", "user", "shift")


def parse_args() -> argparse.Namespace:
	p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	where = p.add_mutually_exclusive_group(required=True)
	where.add_argument("--site", help="local bench site (run from <bench>/sites)")
	where.add_argument("--remote", action="store_true", help="use POSPIRE_RCA_URL / _API_KEY / _API_SECRET")
	for name in ID_ARGS:
		p.add_argument("--" + name.replace("_", "-"), dest=name)
	p.add_argument("--fleet", action="store_true")
	p.add_argument("--since")
	p.add_argument("--until")
	p.add_argument("--no-logs", action="store_true", help="skip bench log file grep")
	p.add_argument("--timeout", type=int, default=60)
	p.add_argument("--out")
	return p.parse_args()


def query_params(args: argparse.Namespace) -> dict[str, str]:
	params = {k: getattr(args, k) for k in ID_ARGS if getattr(args, k)}
	if args.since:
		params["since"] = args.since
	if args.until:
		params["until"] = args.until
	params["fleet"] = "1" if args.fleet else "0"
	params["include_logs"] = "0" if args.no_logs else "1"
	return params


def run_local(args: argparse.Namespace) -> dict:
	import frappe

	frappe.init(site=args.site, sites_path=os.getcwd())
	frappe.connect()
	frappe.set_user("Administrator")
	try:
		from pospire.pospire.api.diagnostics import build_rca_bundle

		p = query_params(args)
		return build_rca_bundle(
			**{k: p.get(k) for k in ID_ARGS},
			since=p.get("since"),
			until=p.get("until"),
			fleet=args.fleet,
			include_logs=not args.no_logs,
			logs_dir=os.path.join(os.getcwd(), "..", "logs"),
		)
	finally:
		frappe.db.rollback()
		frappe.destroy()


def run_remote(args: argparse.Namespace) -> dict:
	base = os.environ.get("POSPIRE_RCA_URL", "").rstrip("/")
	key = os.environ.get("POSPIRE_RCA_API_KEY", "")
	secret = os.environ.get("POSPIRE_RCA_API_SECRET", "")
	if not (base and key and secret):
		sys.exit("set POSPIRE_RCA_URL, POSPIRE_RCA_API_KEY and POSPIRE_RCA_API_SECRET")
	parsed = urllib.parse.urlparse(base)
	is_local = parsed.hostname in ("localhost", "127.0.0.1") or (parsed.hostname or "").endswith(".localhost")
	if parsed.scheme != "https" and not is_local:
		sys.exit("refusing to send API credentials over plain http")

	body = urllib.parse.urlencode(query_params(args)).encode()
	req = urllib.request.Request(
		f"{base}/api/method/{METHOD}",
		data=body,
		headers={
			"Authorization": f"token {key}:{secret}",
			"Accept": "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method="POST",
	)
	try:
		with urllib.request.urlopen(req, timeout=args.timeout) as resp:
			return json.loads(resp.read().decode())["message"]
	except urllib.error.HTTPError as exc:
		detail = exc.read().decode(errors="replace")[:2000]
		sys.exit(f"HTTP {exc.code} from {base}: {detail}")


def main() -> int:
	args = parse_args()
	if not args.fleet and not any(getattr(args, k) for k in ID_ARGS):
		sys.exit("pass an identifier (--invoice, --review, --offline-id, ...) or --fleet")
	bundle = run_remote(args) if args.remote else run_local(args)
	text = json.dumps(bundle, indent=1, default=str)
	if args.out:
		out = os.path.realpath(os.path.expanduser(args.out))
		repo_root = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
		if out.startswith(repo_root + os.sep):
			sys.exit(f"refusing to write evidence (customer data) inside the repo: {out}")
		os.makedirs(os.path.dirname(out), exist_ok=True)
		# Owner-only: bundles carry production payloads and Error Logs.
		fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
		with os.fdopen(fd, "w") as fh:
			fh.write(text)
		print(f"wrote {out} ({len(text)} bytes)", file=sys.stderr)
	else:
		print(text)
	return 0


if __name__ == "__main__":
	sys.exit(main())
